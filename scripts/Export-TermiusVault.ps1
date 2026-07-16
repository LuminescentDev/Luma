[CmdletBinding()]
param(
    [string]$OutputPath = (Join-Path $PWD "termius-vault-export.json"),
    [int]$DebugPort = 19229,
    [ValidateRange(0, 300)] [int]$UnlockWaitSeconds = 0,
    [switch]$KeepTermiusOpen
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Fail([string]$Message) {
    Write-Error $Message
    exit 1
}

function Invoke-Cdp {
    param(
        [Parameter(Mandatory)] [string]$WebSocketUrl,
        [Parameter(Mandatory)] [string]$Expression
    )

    $socket = [System.Net.WebSockets.ClientWebSocket]::new()
    try {
        $null = $socket.ConnectAsync([Uri]$WebSocketUrl, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
        $request = @{
            id = 1
            method = "Runtime.evaluate"
            params = @{
                expression = $Expression
                awaitPromise = $true
                returnByValue = $true
                userGesture = $false
            }
        } | ConvertTo-Json -Depth 8 -Compress
        $bytes = [Text.Encoding]::UTF8.GetBytes($request)
        $segment = [ArraySegment[byte]]::new($bytes)
        $null = $socket.SendAsync($segment, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).GetAwaiter().GetResult()

        $buffer = New-Object byte[] 1048576
        $stream = [IO.MemoryStream]::new()
        do {
            $result = $socket.ReceiveAsync([ArraySegment[byte]]::new($buffer), [Threading.CancellationToken]::None).GetAwaiter().GetResult()
            $null = $stream.Write($buffer, 0, $result.Count)
        } until ($result.EndOfMessage)
        $response = [Text.Encoding]::UTF8.GetString($stream.ToArray()) | ConvertFrom-Json
        if ($response.PSObject.Properties["error"]) { throw "Chrome DevTools error: $($response.error.message)" }
        if ($response.result.PSObject.Properties["exceptionDetails"]) { throw "Termius extraction failed: $($response.result.exceptionDetails.text)" }
        return $response.result.result.value
    }
    finally {
        # Chromium does not consistently complete the close handshake for a
        # short-lived CDP client. The response is already fully received, so an
        # abort avoids a per-request indefinite wait without losing data.
        if ($socket.State -ne [System.Net.WebSockets.WebSocketState]::Closed) {
            $socket.Abort()
        }
        $null = $socket.Dispose()
    }
}

if ($env:OS -ne "Windows_NT") { Fail "This exporter currently supports the Windows Termius desktop application only." }

$termiusExe = Join-Path $env:LOCALAPPDATA "Programs\Termius\Termius.exe"
$profilePath = Join-Path $env:APPDATA "Termius"
if (!(Test-Path -LiteralPath $termiusExe -PathType Leaf)) { Fail "Termius was not found at $termiusExe" }
if (!(Test-Path -LiteralPath $profilePath -PathType Container)) { Fail "The Termius profile was not found at $profilePath" }

$running = @(Get-Process -Name Termius -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
    Fail "Termius is running. Close it completely (including the tray icon), then run this script again. The script never terminates Termius for you."
}

$output = [IO.Path]::GetFullPath($OutputPath)
if (Test-Path -LiteralPath $output) { Fail "Refusing to overwrite existing export: $output" }
$parent = Split-Path -Parent $output
if (!(Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent | Out-Null }

Write-Host "Starting Termius with a local debugging endpoint on 127.0.0.1:$DebugPort ..."
$electronRunAsNode = $env:ELECTRON_RUN_AS_NODE
try {
    # Some developer shells set this globally. It turns Electron executables
    # into Node processes, causing Termius to reject Chromium command-line flags.
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    $process = Start-Process -FilePath $termiusExe -ArgumentList "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=$DebugPort" -PassThru
}
finally {
    if ($null -ne $electronRunAsNode) { $env:ELECTRON_RUN_AS_NODE = $electronRunAsNode }
}

try {
    $targets = $null
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        try {
            $targets = Invoke-RestMethod -Uri "http://127.0.0.1:$DebugPort/json/list" -TimeoutSec 1
            if ($targets) { break }
        } catch { Start-Sleep -Milliseconds 500 }
    }
    if (!$targets) { Fail "Termius did not expose its local debugging endpoint." }

    Write-Host "Unlock Termius normally. No password should be entered in this PowerShell window."
    if ($UnlockWaitSeconds -gt 0) {
        Write-Host "Waiting $UnlockWaitSeconds seconds for the vault to be unlocked ..."
        Start-Sleep -Seconds $UnlockWaitSeconds
    } else {
        Read-Host "After the vault and Hosts screen are visible, press Enter here"
    }

    $targets = Invoke-RestMethod -Uri "http://127.0.0.1:$DebugPort/json/list" -TimeoutSec 3
    $target = $targets | Where-Object { $_.type -eq "page" -and ($_.url -like "file:*" -or $_.title -match "Termius") } | Select-Object -First 1
    if (!$target) { $target = $targets | Where-Object { $_.type -eq "page" } | Select-Object -First 1 }
    if (!$target.webSocketDebuggerUrl) { Fail "Could not locate the unlocked Termius renderer." }

    # Discover databases and counts in a small response first. Records are then
    # fetched in chunks so DevTools never has to serialize the entire vault into
    # one WebSocket message.
    $metadataExpression = @'
(async () => {
  const result = [];
  for (const descriptor of await indexedDB.databases()) {
    if (!descriptor.name) continue;
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(descriptor.name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onupgradeneeded = event => { event.target.transaction.abort(); reject(new Error('Refusing to create or upgrade a database')); };
    });
    try {
      const stores = [];
      for (const name of Array.from(db.objectStoreNames)) {
        const count = await new Promise((resolve, reject) => {
          const request = db.transaction(name, 'readonly').objectStore(name).count();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        stores.push({ name, count });
      }
      result.push({ name: descriptor.name, version: db.version, stores });
    } finally { db.close(); }
  }
  return JSON.stringify(result);
})()
'@
    $metadataJson = Invoke-Cdp -WebSocketUrl $target.webSocketDebuggerUrl -Expression $metadataExpression
    $metadata = [object[]](ConvertFrom-Json -InputObject $metadataJson)
    $databases = [ordered]@{}
    $chunkSize = 100

    foreach ($database in [object[]]$metadata) {
        $stores = [ordered]@{}
        foreach ($store in [object[]]$database.stores) {
            $records = [Collections.Generic.List[object]]::new()
            Write-Host ("Reading {0}/{1} ({2} records) ..." -f $database.name, $store.name, $store.count)
            for ($offset = 0; $offset -lt [int]$store.count; $offset += $chunkSize) {
                $databaseLiteral = $database.name | ConvertTo-Json -Compress
                $storeLiteral = $store.name | ConvertTo-Json -Compress
                $chunkExpression = @"
(async () => {
  const encodeBinary = bytes => {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return btoa(binary);
  };
  const encode = value => {
    if (value instanceof ArrayBuffer) return { `$binary: encodeBinary(new Uint8Array(value)) };
    if (ArrayBuffer.isView(value)) return { `$binary: encodeBinary(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
    if (value instanceof Date) return { `$date: value.toISOString() };
    if (value && typeof value === 'object') {
      if (Array.isArray(value)) return value.map(encode);
      const result = {};
      for (const [key, child] of Object.entries(value)) result[key] = encode(child);
      return result;
    }
    return value;
  };
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open($databaseLiteral);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    const values = await new Promise((resolve, reject) => {
      const values = [];
      const request = db.transaction($storeLiteral, 'readonly').objectStore($storeLiteral).openCursor();
      let advanced = false;
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || values.length >= $chunkSize) return resolve(values);
        if (!advanced && $offset > 0) { advanced = true; cursor.advance($offset); return; }
        advanced = true;
        values.push(cursor.value);
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
    return JSON.stringify(encode(values));
  } finally { db.close(); }
})()
"@
                $chunkJson = Invoke-Cdp -WebSocketUrl $target.webSocketDebuggerUrl -Expression $chunkExpression
                $chunk = [object[]](ConvertFrom-Json -InputObject $chunkJson)
                foreach ($record in $chunk) { $records.Add($record) }
            }
            $stores[$store.name] = $records.ToArray()
        }
        $databases[$database.name] = [ordered]@{ version = $database.version; stores = $stores }
    }

    $snapshot = [ordered]@{
        format = "luma-termius-vault-snapshot"
        version = 1
        source = [ordered]@{ application = "Termius"; platform = "windows" }
        exportedAt = [DateTime]::UtcNow.ToString("o")
        databases = $databases
    }
    $json = $snapshot | ConvertTo-Json -Depth 100 -Compress

    # Create with current-user-only ACL before writing potentially sensitive data.
    [IO.File]::WriteAllText($output, $json, [Text.UTF8Encoding]::new($false))
    $acl = New-Object Security.AccessControl.FileSecurity
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl.SetOwner($user)
    $acl.SetAccessRuleProtection($true, $false)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($user, "FullControl", "Allow")
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $output -AclObject $acl

    $parsed = $json | ConvertFrom-Json
    $counts = @{}
    foreach ($dbProperty in $parsed.databases.PSObject.Properties) {
        foreach ($storeProperty in $dbProperty.Value.stores.PSObject.Properties) {
            $counts[$storeProperty.Name] = @($storeProperty.Value).Count
        }
    }
    Write-Host "Snapshot written with restricted permissions: $output"
    foreach ($name in @("hosts", "groups", "identities", "ssh_keys", "ssh_configs", "ssh_config_identities")) {
        if ($counts.ContainsKey($name)) { Write-Host ("  {0}: {1}" -f $name, $counts[$name]) }
    }
    Write-Warning "This file may contain encrypted credentials and private keys. Treat it as a secret and do not commit or share it."
}
finally {
    if (!$KeepTermiusOpen -and $process -and !$process.HasExited) {
        $process.CloseMainWindow() | Out-Null
        Write-Host "Asked the Termius window started by this script to close."
    }
}
