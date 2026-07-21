use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD};
use base64::Engine as _;
use russh::client;
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::{Row, SqlitePool};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::time::timeout;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use super::build_host_key_probe_arguments;
use super::{classify_error_output, SshConnectionConfig};
use crate::errors::{LumaError, Result};
use crate::storage::hosts::{self, Host};

const PROBE_CONNECT_TIMEOUT_SECONDS: u64 = 10;
const PROBE_PROCESS_TIMEOUT_SECONDS: u64 = 30;
const PENDING_SCAN_TTL: Duration = Duration::from_secs(120);
const MAX_PROBE_OUTPUT_BYTES: usize = 1024 * 1024;
const MAX_PROBE_DIAGNOSTIC_CHARS: usize = 512;
const MAX_KNOWN_HOSTS_BYTES: u64 = 4 * 1024 * 1024;
const MAX_HOST_KEYS: usize = 32;

static PENDING_SCANS: LazyLock<Mutex<HashMap<String, PendingScan>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static KNOWN_HOSTS_FILE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HostKeyStatusKind {
    Known,
    Unknown,
    Changed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyFingerprint {
    pub key_type: String,
    pub fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshHostKeyStatus {
    pub status: HostKeyStatusKind,
    pub scanned_keys: Vec<HostKeyFingerprint>,
    pub known_keys: Vec<HostKeyFingerprint>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownHostsEntry {
    pub line_number: usize,
    pub hosts: String,
    pub key_type: String,
    pub fingerprint: String,
    pub marker: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct HostKey {
    key_type: String,
    encoded_key: String,
    fingerprint: String,
}

#[derive(Debug, Clone)]
struct PendingScan {
    hostname: String,
    port: u16,
    known_hosts_file: PathBuf,
    keys: Vec<HostKey>,
    created_at: Instant,
}

#[derive(Debug, Default)]
struct KnownHostEntries {
    target_entry_exists: bool,
    keys: Vec<HostKey>,
}

#[derive(Debug)]
struct EphemeralKnownHostsFile(PathBuf);

impl EphemeralKnownHostsFile {
    fn create() -> Result<Self> {
        let path = std::env::temp_dir().join(format!(
            "luma-host-key-probe-{}.known_hosts",
            uuid::Uuid::new_v4()
        ));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.open(&path)?;
        Ok(Self(path))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for EphemeralKnownHostsFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

pub fn file_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("known_hosts")
}

pub fn list(known_hosts_file: &Path) -> Result<Vec<KnownHostsEntry>> {
    let _guard = KNOWN_HOSTS_FILE_LOCK.lock().unwrap();
    let contents = read_known_hosts_bytes(known_hosts_file)?;
    let text = std::str::from_utf8(&contents).map_err(|_| LumaError::SshConnection {
        category: "host-key-file-invalid",
        message: "The Luma known_hosts file is not valid UTF-8.".into(),
    })?;
    Ok(parse_management_entries(text))
}

pub fn remove(known_hosts_file: &Path, line_number: usize) -> Result<()> {
    if line_number == 0 {
        return Err(LumaError::InvalidInput(
            "lineNumber must be greater than zero".into(),
        ));
    }
    let _guard = KNOWN_HOSTS_FILE_LOCK.lock().unwrap();
    let contents = read_known_hosts_bytes(known_hosts_file)?;
    let text = std::str::from_utf8(&contents).map_err(|_| LumaError::SshConnection {
        category: "host-key-file-invalid",
        message: "The Luma known_hosts file is not valid UTF-8.".into(),
    })?;
    if !parse_management_entries(text)
        .iter()
        .any(|entry| entry.line_number == line_number)
    {
        return Err(LumaError::InvalidInput(
            "known_hosts entry was not found at lineNumber".into(),
        ));
    }

    let ranges = physical_line_ranges(&contents);
    let Some(range) = ranges.get(line_number - 1) else {
        return Err(LumaError::InvalidInput(
            "known_hosts entry was not found at lineNumber".into(),
        ));
    };
    let mut updated = Vec::with_capacity(contents.len() - (range.end - range.start));
    updated.extend_from_slice(&contents[..range.start]);
    updated.extend_from_slice(&contents[range.end..]);

    let mut file = OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(known_hosts_file)?;
    file.write_all(&updated)?;
    file.sync_all()?;
    Ok(())
}

fn read_known_hosts_bytes(path: &Path) -> Result<Vec<u8>> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    if metadata.len() > MAX_KNOWN_HOSTS_BYTES {
        return Err(LumaError::SshConnection {
            category: "host-key-file-invalid",
            message: "The Luma known_hosts file is too large to read safely.".into(),
        });
    }
    Ok(fs::read(path)?)
}

fn parse_management_entries(contents: &str) -> Vec<KnownHostsEntry> {
    contents
        .lines()
        .enumerate()
        .filter_map(|(index, line)| {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                return None;
            }
            let fields = line.split_whitespace().collect::<Vec<_>>();
            let has_marker = fields.first().is_some_and(|field| field.starts_with('@'));
            let offset = usize::from(has_marker);
            let hosts = *fields.get(offset)?;
            let key_type = *fields.get(offset + 1)?;
            let encoded = *fields.get(offset + 2)?;
            let key = host_key(key_type, encoded)?;
            let hosts = if hosts.split(',').any(|host| host.starts_with("|1|")) {
                format!("Hashed: {hosts}")
            } else {
                hosts.to_string()
            };
            Some(KnownHostsEntry {
                line_number: index + 1,
                hosts,
                key_type: key.key_type,
                fingerprint: key.fingerprint,
                marker: has_marker.then(|| fields[0].trim_start_matches('@').to_string()),
            })
        })
        .collect()
}

fn physical_line_ranges(contents: &[u8]) -> Vec<std::ops::Range<usize>> {
    let mut ranges = Vec::new();
    let mut start = 0;
    for (index, byte) in contents.iter().enumerate() {
        if *byte == b'\n' {
            ranges.push(start..index + 1);
            start = index + 1;
        }
    }
    if start < contents.len() {
        ranges.push(start..contents.len());
    }
    ranges
}

pub async fn file_path_for_pool(pool: &SqlitePool) -> Result<PathBuf> {
    let rows = sqlx::query("PRAGMA database_list").fetch_all(pool).await?;
    for row in rows {
        let name: String = row.try_get("name")?;
        let database_file: String = row.try_get("file")?;
        if name == "main" && !database_file.is_empty() {
            if let Some(parent) = Path::new(&database_file).parent() {
                return Ok(file_path(parent));
            }
        }
    }

    // In-memory databases are used by backend unit tests. The production pool
    // is always backed by app_data_dir/luma.db, so this fallback is not used by
    // the application and never changes the user's OpenSSH configuration.
    Ok(std::env::temp_dir()
        .join("luma")
        .join(format!("known_hosts-test-{}", std::process::id())))
}

pub fn validate_host_id(host_id: &str) -> Result<()> {
    if host_id.trim().is_empty() || host_id.len() > 256 || host_id.contains('\0') {
        return Err(LumaError::InvalidInput("hostId is invalid".into()));
    }
    Ok(())
}

pub async fn status(
    host_id: &str,
    config: &SshConnectionConfig,
    known_hosts_file: &Path,
) -> Result<SshHostKeyStatus> {
    validate_host_id(host_id)?;
    hosts::validate_safe_hostname(config.hostname.trim())?;
    let hostname = normalized_hostname(&config.hostname);
    let target = known_host_target(&hostname, config.port);

    if let Some(keys) = cached_pending_scan(host_id, &hostname, config.port, known_hosts_file) {
        let entries = read_entries_locked(known_hosts_file, &target)?;
        let classification = classify_entries(&entries, &keys);
        if classification != HostKeyStatusKind::Known {
            return Ok(status_response(classification, &keys, &entries.keys));
        }
        PENDING_SCANS.lock().unwrap().remove(host_id);
        return Ok(status_response(classification, &keys, &entries.keys));
    }

    let keys = scan_host_keys(config).await?;
    let entries = read_entries_locked(known_hosts_file, &target)?;
    let classification = classify_entries(&entries, &keys);

    let mut pending = PENDING_SCANS.lock().unwrap();
    prune_expired_scans(&mut pending);
    if classification == HostKeyStatusKind::Known {
        pending.remove(host_id);
    } else {
        pending.insert(
            host_id.to_string(),
            PendingScan {
                hostname,
                port: config.port,
                known_hosts_file: known_hosts_file.to_path_buf(),
                keys: keys.clone(),
                created_at: Instant::now(),
            },
        );
    }

    Ok(status_response(classification, &keys, &entries.keys))
}

pub fn trust(host_id: &str, host: &Host, known_hosts_file: &Path) -> Result<SshHostKeyStatus> {
    validate_host_id(host_id)?;
    hosts::validate_safe_hostname(host.hostname.trim())?;
    let hostname = normalized_hostname(&host.hostname);

    let pending = {
        let mut scans = PENDING_SCANS.lock().unwrap();
        prune_expired_scans(&mut scans);
        scans.get(host_id).cloned()
    }
    .ok_or_else(scan_required_error)?;

    if pending.hostname != hostname
        || pending.port != host.port
        || pending.known_hosts_file != known_hosts_file
    {
        PENDING_SCANS.lock().unwrap().remove(host_id);
        return Err(scan_required_error());
    }

    let result = trust_scanned_keys(known_hosts_file, &hostname, host.port, &pending.keys);
    if result.is_ok()
        || matches!(
            &result,
            Err(LumaError::SshConnection {
                category: "host-key-changed",
                ..
            })
        )
    {
        PENDING_SCANS.lock().unwrap().remove(host_id);
    }
    result
}

fn scan_required_error() -> LumaError {
    LumaError::SshConnection {
        category: "host-key-scan-required",
        message: "Scan the host key again before trusting it.".into(),
    }
}

fn cached_pending_scan(
    host_id: &str,
    hostname: &str,
    port: u16,
    known_hosts_file: &Path,
) -> Option<Vec<HostKey>> {
    let mut scans = PENDING_SCANS.lock().unwrap();
    prune_expired_scans(&mut scans);
    scans.get(host_id).and_then(|scan| {
        (scan.hostname == hostname
            && scan.port == port
            && scan.known_hosts_file == known_hosts_file)
            .then(|| scan.keys.clone())
    })
}

fn prune_expired_scans(scans: &mut HashMap<String, PendingScan>) {
    scans.retain(|_, scan| scan.created_at.elapsed() <= PENDING_SCAN_TTL);
}

struct CappedOutput {
    bytes: Vec<u8>,
    exceeded: bool,
}

async fn read_capped_output<R>(mut reader: R) -> io::Result<CappedOutput>
where
    R: AsyncRead + Unpin,
{
    let mut bytes = Vec::with_capacity(MAX_PROBE_OUTPUT_BYTES.min(16 * 1024));
    let mut exceeded = false;
    let mut buffer = [0_u8; 8192];
    loop {
        let read = reader.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        let remaining = MAX_PROBE_OUTPUT_BYTES.saturating_sub(bytes.len());
        bytes.extend_from_slice(&buffer[..read.min(remaining)]);
        exceeded |= read > remaining;
    }
    Ok(CappedOutput { bytes, exceeded })
}

async fn scan_host_keys(config: &SshConnectionConfig) -> Result<Vec<HostKey>> {
    if config.proxy_jumps.is_empty() {
        return scan_host_key_embedded(config).await;
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    return Err(LumaError::CapabilityUnavailable {
        feature: "systemSsh",
        message:
            "ProxyJump host-key scanning requires system OpenSSH, which is unavailable on mobile"
                .into(),
    });
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let temporary_known_hosts = EphemeralKnownHostsFile::create()?;
        let arguments = build_host_key_probe_arguments(
            config,
            temporary_known_hosts.path(),
            PROBE_CONNECT_TIMEOUT_SECONDS,
        );
        let mut command = Command::new(&config.executable);
        crate::platform::hide_background_tokio_command(&mut command);
        command
            .args(arguments)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = command.spawn().map_err(|error| {
            LumaError::SshUnavailable(format!("failed to start system OpenSSH probe: {error}"))
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            LumaError::SshUnavailable("failed to capture system OpenSSH probe output".into())
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            LumaError::SshUnavailable("failed to capture system OpenSSH probe diagnostics".into())
        })?;
        let capture = async move {
            let (stdout, stderr, status) = tokio::join!(
                read_capped_output(stdout),
                read_capped_output(stderr),
                child.wait()
            );
            status?;
            Ok::<_, io::Error>((stdout?, stderr?))
        };
        let (stdout, stderr) = timeout(Duration::from_secs(PROBE_PROCESS_TIMEOUT_SECONDS), capture)
            .await
            .map_err(|_| LumaError::SshConnection {
                category: "timeout",
                message: format!(
                "The SSH host-key probe timed out after {PROBE_PROCESS_TIMEOUT_SECONDS} seconds."
            ),
            })??;

        if stdout.exceeded || stderr.exceeded {
            return Err(LumaError::SshConnection {
                category: "host-key-scan-failed",
                message: "The SSH host-key probe returned too much diagnostic data.".into(),
            });
        }

        let keys = read_probe_keys(temporary_known_hosts.path())?;
        if !keys.is_empty() {
            return Ok(keys);
        }

        let diagnostic = short_redacted_diagnostic(&stderr.bytes);
        if !diagnostic.is_empty() {
            tracing::warn!(reason = %diagnostic, "SSH host-key probe did not record a target key");
        }
        Err(probe_failure_error(&diagnostic))
    }
}

#[derive(Clone)]
struct ProbeClient {
    key: std::sync::Arc<Mutex<Option<tokio::sync::oneshot::Sender<russh::keys::PublicKey>>>>,
}

impl client::Handler for ProbeClient {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        key: &russh::keys::PublicKey,
    ) -> std::result::Result<bool, Self::Error> {
        if let Some(sender) = self.key.lock().unwrap().take() {
            let _ = sender.send(key.clone());
        }
        Ok(false)
    }
}

async fn scan_host_key_embedded(config: &SshConnectionConfig) -> Result<Vec<HostKey>> {
    let (key_sender, key_receiver) = tokio::sync::oneshot::channel();
    let captured = std::sync::Arc::new(Mutex::new(Some(key_sender)));
    let client_config = std::sync::Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(PROBE_CONNECT_TIMEOUT_SECONDS)),
        ..Default::default()
    });
    let hostname = config.hostname.clone();
    let port = config.port;
    let operation = tokio::spawn(client::connect(
        client_config,
        (hostname, port),
        ProbeClient {
            key: std::sync::Arc::clone(&captured),
        },
    ));
    let result = timeout(
        Duration::from_secs(PROBE_PROCESS_TIMEOUT_SECONDS),
        key_receiver,
    )
    .await;
    if let Ok(Ok(ref key)) = result {
        operation.abort();
        let encoded = key.to_openssh().map_err(|error| LumaError::SshConnection {
            category: "host-key-scan-failed",
            message: format!("The server host key could not be encoded: {error}"),
        })?;
        let mut fields = encoded.split_whitespace();
        if let (Some(key_type), Some(key_data)) = (fields.next(), fields.next()) {
            if let Some(key) = host_key(key_type, key_data) {
                return Ok(vec![key]);
            }
        }
    }
    match result {
        Err(_) => {
            operation.abort();
            Err(LumaError::SshConnection {
                category: "timeout",
                message: format!(
                    "The SSH host-key probe timed out after {PROBE_PROCESS_TIMEOUT_SECONDS} seconds."
                ),
            })
        }
        Ok(Err(_)) => match operation.await {
            Ok(Err(error)) => Err(probe_failure_error(&error.to_string())),
            Ok(Ok(_)) => Err(LumaError::SshConnection {
                category: "host-key-scan-failed",
                message: "The SSH server did not present a host key.".into(),
            }),
            Err(error) => Err(LumaError::SshConnection {
                category: "host-key-scan-failed",
                message: format!("The SSH host-key probe failed: {error}"),
            }),
        },
        Ok(Ok(_)) => unreachable!("successful key delivery returns above"),
    }
}

fn read_probe_keys(path: &Path) -> Result<Vec<HostKey>> {
    let metadata = fs::metadata(path)?;
    if metadata.len() > MAX_PROBE_OUTPUT_BYTES as u64 {
        return Err(LumaError::SshConnection {
            category: "host-key-scan-failed",
            message: "The SSH host-key probe recorded too much key data.".into(),
        });
    }
    parse_scanned_keys(&fs::read(path)?)
}

fn short_redacted_diagnostic(stderr: &[u8]) -> String {
    let diagnostic = String::from_utf8_lossy(stderr);
    let redacted = crate::logging::redact(&diagnostic);
    let mut result = String::new();
    for token in redacted.split_whitespace() {
        let token = if looks_like_encoded_key_material(token) {
            "[REDACTED KEY MATERIAL]"
        } else {
            token
        };
        let separator = usize::from(!result.is_empty());
        if result.chars().count() + separator + token.chars().count() > MAX_PROBE_DIAGNOSTIC_CHARS {
            if !result.is_empty() {
                result.push('…');
            }
            break;
        }
        if !result.is_empty() {
            result.push(' ');
        }
        result.push_str(token);
    }
    result
}

fn looks_like_encoded_key_material(token: &str) -> bool {
    let token = token.trim_matches(|character: char| {
        matches!(character, ',' | ';' | '(' | ')' | '[' | ']' | '"' | '\'')
    });
    token.len() >= 40
        && token.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '+' | '/' | '=')
        })
}

fn probe_failure_error(diagnostic: &str) -> LumaError {
    let classified = classify_error_output(diagnostic).filter(|(category, _)| {
        matches!(
            *category,
            "dns-failed" | "host-unreachable" | "timeout" | "host-key-changed"
        )
    });
    let (category, base_message) = classified.unwrap_or((
        "host-key-scan-failed",
        "No SSH host key could be obtained through the configured route.",
    ));
    let message = if diagnostic.is_empty() {
        base_message.to_string()
    } else {
        format!("{base_message} OpenSSH reported: {diagnostic}")
    };
    LumaError::SshConnection { category, message }
}

fn normalized_hostname(hostname: &str) -> String {
    let hostname = hostname.trim();
    if hostname.starts_with('[')
        && hostname.ends_with(']')
        && hostname[1..hostname.len() - 1].contains(':')
    {
        hostname[1..hostname.len() - 1].to_string()
    } else {
        hostname.to_string()
    }
}

fn known_host_target(hostname: &str, port: u16) -> String {
    if port == 22 {
        hostname.to_string()
    } else {
        format!("[{hostname}]:{port}")
    }
}

fn parse_scanned_keys(output: &[u8]) -> Result<Vec<HostKey>> {
    let text = std::str::from_utf8(output).map_err(|_| LumaError::SshConnection {
        category: "host-key-scan-failed",
        message: "The host key scan returned invalid text.".into(),
    })?;
    let mut keys = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let fields = line.split_whitespace().collect::<Vec<_>>();
        let offset = usize::from(fields.first().is_some_and(|field| field.starts_with('@')));
        let Some(key_type) = fields.get(offset + 1).copied() else {
            continue;
        };
        let Some(encoded_key) = fields.get(offset + 2).copied() else {
            continue;
        };
        if !valid_key_type(key_type) {
            continue;
        }
        let Some(key) = host_key(key_type, encoded_key) else {
            continue;
        };
        if !keys.iter().any(|existing: &HostKey| {
            existing.key_type == key.key_type && existing.encoded_key == key.encoded_key
        }) {
            keys.push(key);
        }
        if keys.len() > MAX_HOST_KEYS {
            return Err(LumaError::SshConnection {
                category: "host-key-scan-failed",
                message: "The host key scan returned too many keys.".into(),
            });
        }
    }
    sort_keys(&mut keys);
    Ok(keys)
}

fn valid_key_type(key_type: &str) -> bool {
    !key_type.is_empty()
        && key_type.len() <= 128
        && key_type.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | '@' | '+')
        })
}

fn host_key(key_type: &str, encoded_key: &str) -> Option<HostKey> {
    if encoded_key.is_empty() || encoded_key.len() > 64 * 1024 {
        return None;
    }
    let decoded = STANDARD.decode(encoded_key).ok()?;
    if decoded.is_empty() || decoded.len() > 32 * 1024 {
        return None;
    }
    let digest = Sha256::digest(&decoded);
    Some(HostKey {
        key_type: key_type.to_string(),
        encoded_key: encoded_key.to_string(),
        fingerprint: format!("SHA256:{}", STANDARD_NO_PAD.encode(digest)),
    })
}

fn read_entries_locked(known_hosts_file: &Path, target: &str) -> Result<KnownHostEntries> {
    let _guard = KNOWN_HOSTS_FILE_LOCK.lock().unwrap();
    read_entries(known_hosts_file, target)
}

fn read_entries(known_hosts_file: &Path, target: &str) -> Result<KnownHostEntries> {
    let metadata = match fs::metadata(known_hosts_file) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(KnownHostEntries::default())
        }
        Err(error) => return Err(error.into()),
    };
    if metadata.len() > MAX_KNOWN_HOSTS_BYTES {
        return Err(LumaError::SshConnection {
            category: "host-key-file-invalid",
            message: "The Luma known_hosts file is too large to read safely.".into(),
        });
    }

    let contents = fs::read_to_string(known_hosts_file)?;
    let mut entries = KnownHostEntries::default();
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let fields = line.split_whitespace().collect::<Vec<_>>();
        let offset = usize::from(fields.first().is_some_and(|field| field.starts_with('@')));
        if fields.len() < offset + 3 {
            if fields
                .get(offset)
                .is_some_and(|hosts| host_list_contains(hosts, target))
            {
                entries.target_entry_exists = true;
            }
            continue;
        }
        if !host_list_contains(fields[offset], target) {
            continue;
        }
        entries.target_entry_exists = true;
        if let Some(key) = host_key(fields[offset + 1], fields[offset + 2]) {
            entries.keys.push(key);
        }
    }
    sort_keys(&mut entries.keys);
    Ok(entries)
}

fn host_list_contains(hosts: &str, target: &str) -> bool {
    hosts.split(',').any(|host| host == target)
}

fn classify_entries(entries: &KnownHostEntries, scanned: &[HostKey]) -> HostKeyStatusKind {
    if !entries.target_entry_exists {
        return HostKeyStatusKind::Unknown;
    }

    let has_exact_match = entries.keys.iter().any(|known| {
        scanned.iter().any(|scanned| {
            known.key_type == scanned.key_type && known.encoded_key == scanned.encoded_key
        })
    });
    let has_same_type_conflict = entries.keys.iter().any(|known| {
        scanned.iter().any(|scanned| {
            known.key_type == scanned.key_type && known.encoded_key != scanned.encoded_key
        })
    });

    if has_exact_match && !has_same_type_conflict {
        HostKeyStatusKind::Known
    } else {
        HostKeyStatusKind::Changed
    }
}

fn trust_scanned_keys(
    known_hosts_file: &Path,
    hostname: &str,
    port: u16,
    scanned: &[HostKey],
) -> Result<SshHostKeyStatus> {
    let _guard = KNOWN_HOSTS_FILE_LOCK.lock().unwrap();
    let target = known_host_target(hostname, port);
    let entries = read_entries(known_hosts_file, &target)?;
    match classify_entries(&entries, scanned) {
        HostKeyStatusKind::Changed => Err(LumaError::SshConnection {
            category: "host-key-changed",
            message: "The remote host key differs from the existing Luma known_hosts entry. The existing key was not replaced.".into(),
        }),
        HostKeyStatusKind::Known => Ok(status_response(
            HostKeyStatusKind::Known,
            scanned,
            &entries.keys,
        )),
        HostKeyStatusKind::Unknown => {
            append_keys(known_hosts_file, &target, scanned)?;
            Ok(status_response(
                HostKeyStatusKind::Known,
                scanned,
                scanned,
            ))
        }
    }
}

fn append_keys(known_hosts_file: &Path, target: &str, keys: &[HostKey]) -> Result<()> {
    if keys.is_empty() {
        return Err(LumaError::SshConnection {
            category: "host-key-scan-failed",
            message: "No scanned host key is available to trust.".into(),
        });
    }
    if let Some(parent) = known_hosts_file.parent() {
        fs::create_dir_all(parent)?;
    }
    let existing = match fs::read(known_hosts_file) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(error.into()),
    };

    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(known_hosts_file)?;
    if !existing.is_empty() && !existing.ends_with(b"\n") {
        file.write_all(b"\n")?;
    }
    for key in keys {
        writeln!(file, "{target} {} {}", key.key_type, key.encoded_key)?;
    }
    file.sync_all()?;
    Ok(())
}

fn status_response(
    status: HostKeyStatusKind,
    scanned: &[HostKey],
    known: &[HostKey],
) -> SshHostKeyStatus {
    SshHostKeyStatus {
        status,
        scanned_keys: fingerprints(scanned),
        known_keys: fingerprints(known),
    }
}

fn fingerprints(keys: &[HostKey]) -> Vec<HostKeyFingerprint> {
    keys.iter()
        .map(|key| HostKeyFingerprint {
            key_type: key.key_type.clone(),
            fingerprint: key.fingerprint.clone(),
        })
        .collect()
}

fn sort_keys(keys: &mut [HostKey]) {
    keys.sort_by(|left, right| {
        left.key_type
            .cmp(&right.key_type)
            .then_with(|| left.fingerprint.cmp(&right.fingerprint))
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encoded(value: &[u8]) -> String {
        STANDARD.encode(value)
    }

    #[tokio::test]
    async fn probe_output_capture_stays_within_the_configured_cap() {
        use tokio::io::AsyncWriteExt;

        let (mut writer, reader) = tokio::io::duplex(16 * 1024);
        let writer_task = tokio::spawn(async move {
            writer
                .write_all(&vec![b'x'; MAX_PROBE_OUTPUT_BYTES + 128])
                .await
                .unwrap();
            writer.shutdown().await.unwrap();
        });
        let captured = read_capped_output(reader).await.unwrap();
        writer_task.await.unwrap();

        assert_eq!(captured.bytes.len(), MAX_PROBE_OUTPUT_BYTES);
        assert!(captured.exceeded);
    }

    fn key(key_type: &str, value: &[u8]) -> HostKey {
        host_key(key_type, &encoded(value)).unwrap()
    }

    fn test_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "luma-known-hosts-{label}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ))
    }

    #[test]
    fn classifies_known_unknown_and_changed_keys() {
        let current = key("ssh-ed25519", b"current host key");
        let replacement = key("ssh-ed25519", b"replacement host key");
        let empty = KnownHostEntries::default();
        assert_eq!(
            classify_entries(&empty, std::slice::from_ref(&current)),
            HostKeyStatusKind::Unknown
        );

        let known = KnownHostEntries {
            target_entry_exists: true,
            keys: vec![current.clone()],
        };
        assert_eq!(
            classify_entries(&known, std::slice::from_ref(&current)),
            HostKeyStatusKind::Known
        );
        assert_eq!(
            classify_entries(&known, std::slice::from_ref(&replacement)),
            HostKeyStatusKind::Changed
        );
    }

    #[test]
    fn trusting_refuses_to_replace_a_differing_key() {
        let path = test_path("changed");
        let target = "server.example.com";
        let original = key("ssh-ed25519", b"original host key");
        let replacement = key("ssh-ed25519", b"replacement host key");
        fs::write(
            &path,
            format!("{target} {} {}\n", original.key_type, original.encoded_key),
        )
        .unwrap();

        let replacement_encoded = replacement.encoded_key.clone();
        let error = trust_scanned_keys(&path, target, 22, &[replacement]).unwrap_err();
        assert_eq!(error.category(), "host-key-changed");
        let contents = fs::read_to_string(&path).unwrap();
        assert!(contents.contains(&original.encoded_key));
        assert!(!contents.contains(&replacement_encoded));
        assert_eq!(contents.lines().count(), 1);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn trusting_unknown_keys_writes_canonical_target_and_fingerprints() {
        let path = test_path("unknown");
        let scanned = vec![
            key("ssh-ed25519", b"ed25519 host key"),
            key("ssh-rsa", b"rsa host key"),
        ];
        let result = trust_scanned_keys(&path, "server.example.com", 2222, &scanned).unwrap();

        assert_eq!(result.status, HostKeyStatusKind::Known);
        assert_eq!(result.scanned_keys.len(), 2);
        assert!(result
            .scanned_keys
            .iter()
            .all(|key| key.fingerprint.starts_with("SHA256:")));
        let contents = fs::read_to_string(&path).unwrap();
        assert!(contents
            .lines()
            .all(|line| line.starts_with("[server.example.com]:2222 ")));

        let _ = fs::remove_file(path);
    }

    #[test]
    fn parses_probe_known_hosts_lines_into_fingerprints() {
        let first = encoded(b"first key");
        let second = encoded(b"second key");
        let output = format!(
            "# OpenSSH comment\n|1|hashed-host|hashed-value ssh-ed25519 {first}\n[alias.example.com]:2222 ssh-rsa {second} optional-comment\n"
        );
        let keys = parse_scanned_keys(output.as_bytes()).unwrap();
        assert_eq!(keys.len(), 2);
        assert!(keys
            .iter()
            .all(|key| key.fingerprint.starts_with("SHA256:")));
        assert!(keys.iter().any(|key| key.key_type == "ssh-ed25519"));
        assert!(keys.iter().any(|key| key.key_type == "ssh-rsa"));
    }

    #[test]
    fn management_list_parses_entries_and_remove_preserves_other_bytes() {
        let path = test_path("management");
        let plain = encoded(b"plain management key");
        let hashed = encoded(b"hashed management key");
        let multi = encoded(b"multi management key");
        let fixture = format!(
            "# retained comment\r\nexample.com ssh-ed25519 {plain} first\r\n|1|salt|hash ssh-rsa {hashed}\r\n@revoked one.example,two.example ssh-ed25519 {multi}\r\n# final comment without newline"
        );
        fs::write(&path, fixture.as_bytes()).unwrap();

        let entries = list(&path).unwrap();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].line_number, 2);
        assert_eq!(entries[0].hosts, "example.com");
        assert!(entries[0].fingerprint.starts_with("SHA256:"));
        assert_eq!(entries[1].line_number, 3);
        assert!(entries[1].hosts.starts_with("Hashed: |1|"));
        assert_eq!(entries[2].hosts, "one.example,two.example");
        assert_eq!(entries[2].marker.as_deref(), Some("revoked"));

        remove(&path, 3).unwrap();
        let expected = format!(
            "# retained comment\r\nexample.com ssh-ed25519 {plain} first\r\n@revoked one.example,two.example ssh-ed25519 {multi}\r\n# final comment without newline"
        );
        assert_eq!(fs::read(&path).unwrap(), expected.as_bytes());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn ephemeral_probe_known_hosts_file_is_removed_on_drop() {
        let temporary = EphemeralKnownHostsFile::create().unwrap();
        let path = temporary.path().to_path_buf();
        assert!(path.is_file());
        drop(temporary);
        assert!(!path.exists());
    }

    #[test]
    fn probe_diagnostic_is_redacted_short_and_classified() {
        let secret = "A".repeat(80);
        let stderr = format!(
            "proxy password=hunter2 failed with {secret}\nssh: connect to host relay port 22: Connection timed out"
        );
        let diagnostic = short_redacted_diagnostic(stderr.as_bytes());
        assert!(diagnostic.contains("password=[REDACTED]"));
        assert!(diagnostic.contains("[REDACTED KEY MATERIAL]"));
        assert!(!diagnostic.contains("hunter2"));
        assert!(!diagnostic.contains(&secret));
        assert!(diagnostic.chars().count() <= MAX_PROBE_DIAGNOSTIC_CHARS + 1);
        assert_eq!(probe_failure_error(&diagnostic).category(), "timeout");
    }
}
