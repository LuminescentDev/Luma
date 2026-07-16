# Luma Terminal — Build Plan

## Product Goal

Build **Luma**, a lightweight cross-platform terminal and SSH client for Windows, macOS, and Linux.

Luma should sit between Tabby and Electerm:

* Modern, minimal interface
* Lower memory usage than Electron applications
* Saved SSH hosts and groups
* Local terminal support
* Encrypted sync for hosts, settings, snippets, and optional SSH keys
* No required paid cloud service
* No user account required
* Focus on terminal, SSH, SFTP, and host management

## Primary Stack

### Desktop

* Tauri 2
* Rust backend
* React
* TypeScript
* Vite

### Frontend

* React Router only if routing is necessary
* Zustand for global application state
* TanStack Query only for asynchronous backend data
* Tailwind CSS
* Radix UI primitives
* Lucide icons
* xterm.js for terminal rendering
* xterm-addon-fit
* xterm-addon-search
* xterm-addon-web-links
* xterm-addon-webgl where supported

Avoid large component frameworks such as Material UI, Ant Design, or Bootstrap.

### Backend

* Rust
* Tokio async runtime
* SQLite through SQLx
* portable-pty for local shell sessions
* System OpenSSH for initial SSH implementation
* OS keychain integration:

  * Windows Credential Manager
  * macOS Keychain
  * Linux Secret Service
* Argon2id for passphrase key derivation
* XChaCha20-Poly1305 for vault encryption

## Core Architecture

Use a frontend/backend separation.

The React frontend handles:

* Application layout
* Host manager
* Terminal tabs and panes
* Settings
* Key management UI
* Sync configuration
* SFTP browser
* Command palette

The Rust backend handles:

* PTY processes
* SSH processes
* Terminal I/O
* Database access
* Filesystem operations
* Encryption
* Sync providers
* Secret storage
* SFTP operations
* Port forwarding
* Import and export

Do not push terminal output through React state.

Terminal byte streams should flow directly between Rust and xterm.js using Tauri channels or another persistent streaming mechanism.

React state should only contain session metadata such as:

```ts
type TerminalSession = {
  id: string;
  title: string;
  type: "local" | "ssh";
  hostId?: string;
  status: "connecting" | "connected" | "disconnected" | "error";
  activePaneId: string;
};
```

## Application Layout

### Sidebar

* Search
* Hosts
* Host groups
* Active sessions
* SFTP
* Snippets
* Settings

### Main Area

* Terminal tab bar
* Split-pane terminal workspace
* Empty-state connection launcher
* SFTP browser when selected

### Command Palette

Support commands such as:

* Connect to host
* Open local terminal
* Split terminal
* Close session
* Search terminal
* Open SFTP
* Run snippet
* Open settings

Suggested shortcut:

```text
Ctrl/Cmd + Shift + P
```

## Core Features

### Local Terminal

* Open the system default shell
* Allow custom shell profiles
* Support PowerShell, Command Prompt, Bash, Zsh, Fish, and WSL
* Configurable working directory
* Configurable environment variables
* Tabs
* Horizontal and vertical splits
* Terminal search
* Copy and paste
* Scrollback configuration
* Reconnect or restart local shell

### SSH Hosts

Each host should support:

```ts
type Host = {
  id: string;
  name: string;
  hostname: string;
  port: number;
  username?: string;
  groupId?: string;
  authenticationType: "agent" | "key" | "password" | "interactive";
  keyId?: string;
  proxyJumpHostId?: string;
  startupCommand?: string;
  workingDirectory?: string;
  environment?: Record<string, string>;
  tags: string[];
};
```

Required functionality:

* Create, edit, duplicate, and delete hosts
* Organize hosts into groups
* Search hosts
* Favorite hosts
* Track recently used hosts
* Connect using OpenSSH
* Password authentication
* Private key authentication
* SSH agent authentication
* ProxyJump support
* Known-host verification
* Clear warning when a host key changes
* Configurable keepalive
* Automatic reconnect option
* Import from `~/.ssh/config`

Never automatically accept unknown or changed SSH host keys without user confirmation.

### SSH Engine

Use the system OpenSSH client for the first version.

The backend should:

* Detect the available `ssh` executable
* Construct arguments safely
* Never concatenate untrusted values into shell command strings
* Launch SSH directly as a process
* Attach SSH to a PTY
* Support `ProxyJump`
* Support identity files
* Support agent forwarding as an explicit option
* Parse connection failures into user-readable errors where possible

Design an abstraction so a native Rust SSH engine can be added later.

```rust
trait SshEngine {
    async fn connect(&self, config: SshConnectionConfig) -> Result<SessionHandle>;
    async fn disconnect(&self, session_id: &str) -> Result<()>;
    async fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<()>;
    async fn write(&self, session_id: &str, data: &[u8]) -> Result<()>;
}
```

### Terminal Session Manager

Terminal instances must exist outside normal React component state.

Maintain:

* xterm.js instance
* fit addon
* search addon
* backend session ID
* current dimensions
* connection status
* pane assignment

Inactive terminals should not continuously render.

Dispose all listeners, addons, PTYs, and child processes when a session closes.

## SSH Key Management

Support logical key identities.

```ts
type KeyReference = {
  id: string;
  name: string;
  publicKey?: string;
  storageMode: "local-path" | "encrypted-vault" | "ssh-agent";
  localPath?: string;
  fingerprint?: string;
};
```

### Default Behavior

Use local key references.

Example:

```text
Logical key: personal-ed25519

Windows:
C:\Users\User\.ssh\id_ed25519

macOS/Linux:
~/.ssh/id_ed25519
```

Each device may map the same logical key to a different local path.

### Optional Encrypted Key Sync

Allow users to place private keys inside the encrypted Luma vault.

Requirements:

* Disabled by default
* Strong warning before enabling
* Keys encrypted before leaving the device
* Never store private keys in plaintext database fields
* Decrypt only when required
* Minimize the lifetime of decrypted key material
* Never log private key contents
* Never include keys in crash reports

## Local Storage

Use SQLite.

Suggested tables:

* `hosts`
* `host_groups`
* `key_references`
* `terminal_profiles`
* `snippets`
* `settings`
* `recent_connections`
* `sync_state`
* `vault_metadata`

Sensitive values must not be stored directly in normal SQLite columns.

Store secrets in:

* OS credential vault
* Encrypted Luma vault

Use versioned database migrations.

## Sync System

Sync should be optional and provider-based.

Initial providers:

1. Local folder
2. WebDAV
3. GitHub Gist
4. Generic S3-compatible storage later

Do not require a Luma account.

### Synced Data

* Hosts
* Host groups
* Settings
* Themes
* Snippets
* Terminal profiles
* Key references
* Optional encrypted private keys

### Sync Format

Use one versioned encrypted bundle.

```json
{
  "formatVersion": 1,
  "deviceId": "uuid",
  "updatedAt": "ISO-8601",
  "hosts": [],
  "hostGroups": [],
  "keyReferences": [],
  "terminalProfiles": [],
  "snippets": [],
  "settings": {}
}
```

The serialized bundle must be encrypted before upload.

Encryption flow:

```text
User passphrase
→ Argon2id
→ encryption key
→ XChaCha20-Poly1305
→ encrypted sync blob
```

Store the unlock key or derived-key wrapping material in the OS keychain only when the user enables "remember vault password."

### Sync Behavior

* Manual sync button
* Optional sync on application start
* Optional sync after local changes
* Optional periodic sync
* Track device IDs
* Track object-level update timestamps
* Preserve deleted-object tombstones
* Detect conflicts
* Never silently overwrite conflicting changes
* Provide a basic conflict resolution screen

## SFTP

Add after core SSH sessions are stable.

Required features:

* Browse remote directories
* Browse local directories
* Upload files
* Download files
* Create folders
* Rename
* Delete with confirmation
* Drag and drop
* Transfer progress
* Cancel transfers
* Transfer queue
* Retry failed transfers

Prefer using system `sftp` initially only if integration is reliable. Otherwise use a dedicated Rust SFTP library behind a backend abstraction.

Do not block terminal sessions during transfers.

## Port Forwarding

Support:

* Local forwarding
* Remote forwarding
* Dynamic SOCKS forwarding

Store forwarding profiles per host.

Example:

```ts
type PortForward = {
  id: string;
  hostId: string;
  type: "local" | "remote" | "dynamic";
  bindAddress: string;
  localPort?: number;
  destinationHost?: string;
  destinationPort?: number;
  remotePort?: number;
};
```

Display active tunnels and allow them to be stopped independently.

## Snippets

Support reusable commands.

```ts
type Snippet = {
  id: string;
  name: string;
  command: string;
  description?: string;
  tags: string[];
  variables?: string[];
};
```

Features:

* Search snippets
* Insert into terminal
* Run immediately
* Variable prompts
* Host-specific snippets
* Synced through encrypted sync

Default behavior should insert rather than immediately execute.

## Themes and Appearance

Support:

* Light mode
* Dark mode
* Follow system
* Terminal themes
* Font family
* Font size
* Line height
* Cursor style
* Cursor blinking
* Background opacity
* Optional background blur where supported

Ship with a small number of polished themes.

Use "Luma" branding around soft light, glow, and clarity, but keep terminal backgrounds readable and restrained.

## Cross-Platform Requirements

### Windows

* Windows 10 and newer
* WebView2
* ConPTY
* PowerShell
* Command Prompt
* WSL profiles
* Credential Manager
* MSI or NSIS installer

### macOS

* Intel and Apple Silicon
* WKWebView
* Zsh and Bash
* Keychain
* DMG distribution
* Signed and notarized builds when release infrastructure is ready

### Linux

* WebKitGTK
* Bash, Zsh, and Fish
* Secret Service
* AppImage
* `.deb`
* Optional `.rpm`

Normalize paths in Rust and avoid frontend assumptions about path separators.

Use `Ctrl` shortcuts on Windows/Linux and `Cmd` equivalents on macOS.

## Performance Requirements

Targets are guidelines and should be measured continuously.

* Fast cold startup
* Idle memory materially below typical Electron terminal apps
* No terminal output stored in React state
* No unnecessary polling
* No background sync when disabled
* Lazy-load SFTP, settings, and key-management screens
* Virtualize long host and file lists
* Suspend rendering of hidden terminal panes
* Limit default scrollback
* Clean up all processes and subscriptions
* Avoid Monaco Editor unless required later
* Avoid large animation libraries

Create a benchmark script that measures:

* Cold startup time
* Idle memory
* Memory per terminal session
* CPU usage during high-output commands
* Memory after opening and closing 20 sessions
* Large scrollback behavior
* SFTP transfer memory usage

## Security Requirements

* Never log passwords, tokens, passphrases, or private keys
* Redact sensitive command arguments from logs
* Use parameterized SQL
* Validate all Tauri command inputs
* Apply strict Tauri capability permissions
* Do not expose unrestricted filesystem APIs to the frontend
* Do not expose arbitrary process execution to the frontend
* Never run SSH commands through a shell when direct process execution works
* Confirm changed SSH host keys
* Encrypt all sync data before upload
* Make telemetry opt-in
* Do not collect terminal input or output
* Sign release binaries
* Generate checksums for releases
* Add dependency and vulnerability scanning

## Error Handling

Create user-readable error categories:

* SSH executable unavailable
* Authentication failed
* Host unreachable
* DNS resolution failed
* Connection timed out
* Host key rejected
* Host key changed
* Private key unavailable
* Vault locked
* Sync authentication failed
* Sync conflict
* PTY process exited
* SFTP transfer failed

Detailed internal errors may be written to local logs after sensitive information is removed.

## Suggested Repository Structure

```text
luma/
├── src/
│   ├── app/
│   ├── components/
│   ├── features/
│   │   ├── hosts/
│   │   ├── terminal/
│   │   ├── sftp/
│   │   ├── keys/
│   │   ├── sync/
│   │   ├── snippets/
│   │   └── settings/
│   ├── stores/
│   ├── hooks/
│   ├── lib/
│   ├── types/
│   └── styles/
├── src-tauri/
│   ├── src/
│   │   ├── commands/
│   │   ├── terminal/
│   │   ├── ssh/
│   │   ├── sftp/
│   │   ├── storage/
│   │   ├── vault/
│   │   ├── sync/
│   │   ├── keychain/
│   │   ├── platform/
│   │   └── errors/
│   ├── migrations/
│   └── capabilities/
├── tests/
├── scripts/
└── docs/
```

## Implementation Phases

### Phase 1: Foundation

Build:

* Tauri application shell
* React layout
* Sidebar
* Tab system
* Settings storage
* SQLite migrations
* Logging with secret redaction
* Theme support
* CI for Windows, macOS, and Linux

Completion criteria:

* Application builds on all three operating systems
* Settings persist
* No unrestricted Tauri permissions
* Basic installer artifacts are generated

### Phase 2: Local Terminal

Build:

* PTY backend
* xterm.js integration
* Terminal resizing
* Local shell profiles
* Tabs
* Session lifecycle
* Search
* Copy and paste
* Scrollback settings

Completion criteria:

* PowerShell works on Windows
* Zsh works on macOS
* Bash works on Linux
* High-output commands do not freeze React
* Closed sessions leave no child process running

### Phase 3: SSH Hosts

Build:

* Host database
* Host groups
* Host editor
* Search
* Recent hosts
* OpenSSH adapter
* Password, key, and agent authentication
* Known-host verification
* SSH config import
* ProxyJump

Completion criteria:

* Users can save and connect to hosts
* Host key changes produce a blocking warning
* Host import works without modifying the original SSH config
* Failed connections produce readable errors

### Phase 4: Layout and Productivity

Build:

* Split panes
* Command palette
* Snippets
* Favorites
* Reconnect
* Per-host terminal configuration
* Port forwarding

Completion criteria:

* Sessions can move between panes
* Layout survives tab changes
* Closing panes correctly disposes sessions
* Tunnels can start and stop independently

### Phase 5: Encryption and Sync

Build:

* Vault creation
* Vault unlock
* OS keychain integration
* Encrypted export/import
* Local folder sync
* WebDAV sync
* GitHub Gist sync
* Conflict detection
* Sync status UI

Completion criteria:

* Remote providers never receive plaintext data
* Wrong passphrases fail safely
* Sync conflicts cannot silently destroy data
* Multiple devices can merge non-conflicting changes

### Phase 6: SFTP

Build:

* Remote file browser
* Local file browser
* Transfer queue
* Upload and download
* Progress
* Cancellation
* Drag and drop
* Retry behavior

Completion criteria:

* Large transfers do not freeze the application
* Transfers can be cancelled
* Failed transfers remain visible with retry options
* Terminal sessions remain responsive during transfers

### Phase 7: Release Hardening

Build:

* Auto-update support
* Crash recovery
* Signed releases
* Checksums
* Dependency scanning
* Performance benchmarks
* Accessibility pass
* Keyboard navigation
* Import tools for Tabby and Electerm where practical

## Initial Release Scope

Version `0.1` should include:

* Windows, macOS, and Linux builds
* Local terminals
* SSH hosts and groups
* Tabs
* Split panes
* Key and agent authentication
* SSH config import
* Known-host verification
* Search
* Basic snippets
* Settings
* Manual encrypted export/import

Version `0.2` should add:

* GitHub Gist sync
* WebDAV sync
* OS keychain integration
* Port forwarding
* Improved session restoration

Version `0.3` should add:

* SFTP
* Encrypted private-key sync
* Conflict resolution
* Import from competing terminal applications

## Explicit Non-Goals for Early Versions

Do not initially build:

* Custom SSH protocol implementation
* Custom terminal renderer
* RDP
* VNC
* Serial terminal
* Telnet
* Embedded browser
* Team accounts
* Paid cloud service
* AI command generation
* Collaboration
* Mobile application
* Remote desktop support
* Plugin marketplace
* Full shell-history synchronization

## Definition of Done

The first stable release is complete when:

* It runs reliably on Windows, macOS, and Linux
* It uses less idle memory than comparable Electron terminal applications
* Local and SSH terminals survive normal daily usage
* Terminal output never causes React-wide rerenders
* Hosts can be imported, organized, and searched
* SSH host keys are verified safely
* Secrets are stored using the OS keychain or encrypted vault
* Sync providers only receive encrypted data
* Sessions and child processes always clean up correctly
* Installers are automatically produced by CI
* Core functionality is covered by Rust and frontend tests
* High-output, reconnect, large-scrollback, and multi-session scenarios are benchmarked

---

## Decisions Log (project-specific, made 2026-07-15)

* SSH password auth in v0.1 is **interactive-only**: users type passwords in the terminal when system OpenSSH prompts. Saved-password autofill (SSH_ASKPASS or a native Rust SSH engine) is deferred.
* Sequencing is **breadth-first**: complete each phase fully before starting the next.
* Visual identity: **dark-first** with luminous cyan accent (#4cc9f0); light and follow-system themes supported. Resolved theme is applied via `data-theme` on `<html>`.
* License: MIT.

## Progress

* Phase 1: Foundation — **complete** (commit c10ef92)
* Phase 2: Local Terminal — **complete** (commit 1370e68)
* Phase 3: SSH Hosts — **complete** (not yet committed)
* Phase 4: Layout and Productivity — **complete** (not yet committed) — split panes
  (nestable horizontal/vertical splits with draggable dividers, per-pane
  sessions, move/swap, layout survives tab switches, closing a tab disposes all
  its panes' sessions), command palette (Ctrl/Cmd+Shift+P), snippets UI
  (insert/run with variable prompting), and port forwarding (per-host CRUD plus
  independently start/stoppable tunnels with active-tunnel indicators). Split
  panes spawn a new default local shell, or duplicate the source pane's SSH host
  when splitting an SSH session. Shortcuts: Ctrl/Cmd+Shift+D split right,
  Ctrl/Cmd+Shift+E split down, Ctrl/Cmd+Shift+W close pane.
* Phase 5: Encryption and Sync — **complete** (not yet committed) — the vault
  (create/unlock/lock with remember-on-device) plus the full encryption + sync
  UI on top of the validated backend. Settings gains a Sync section (provider
  selection for local folder / WebDAV / GitHub Gist with folder picking via the
  dialog plugin, transient-only credentials, a set-passphrase flow with
  remember-on-device, relative last-synced status, and a Sync now / disable
  flow) and an Encrypted backup section (encrypted export/import via save/open
  dialogs with passphrase prompts, import preview with object counts, and
  wrong-passphrase retry without re-picking the file). A reusable blocking
  conflict-resolution dialog (per-row keep-local / take-remote plus bulk
  actions, Apply gated until every row is chosen) is shared by live sync
  (sync_resolve) and import (import_apply), so conflicts can never silently
  destroy data. A lightweight sync store wraps sync_now/sync_resolve and backs
  both the settings UI and a title-bar cloud indicator (idle/syncing/error/
  conflict) that runs sync or opens pending conflicts on click. Secrets stay in
  transient form state only — never in stores, the query cache, or storage.
  Typed wrappers live in src/lib/sync.ts, query/mutation hooks in
  src/hooks/useSync.ts.
