use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::time::timeout;

#[cfg(unix)]
const CONTROL_PATH_MAX_BYTES: usize = 90;
const DETECTION_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_DETECTION_OUTPUT_BYTES: usize = 64 * 1024;
const NO_REAUTH_OPTIONS: [&str; 12] = [
    "ControlMaster=no",
    "BatchMode=yes",
    "NumberOfPasswordPrompts=0",
    "PasswordAuthentication=no",
    "KbdInteractiveAuthentication=no",
    "PubkeyAuthentication=no",
    "HostbasedAuthentication=no",
    "GSSAPIAuthentication=no",
    "ProxyJump=none",
    "ProxyCommand=none",
    "ConnectionAttempts=1",
    "ConnectTimeout=3",
];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshRemoteOs {
    pub os_id: String,
    pub pretty_name: Option<String>,
}

impl SshRemoteOs {
    pub fn unknown() -> Self {
        Self {
            os_id: "unknown".into(),
            pretty_name: None,
        }
    }
}

#[derive(Debug, Clone)]
pub(super) struct RemoteOsTarget {
    executable: String,
    hostname: String,
    port: u16,
    username: Option<String>,
    direct_probe_arguments: Vec<String>,
    environment: HashMap<String, String>,
}

impl RemoteOsTarget {
    pub(super) fn new(
        executable: String,
        hostname: String,
        port: u16,
        username: Option<String>,
        direct_probe_arguments: Vec<String>,
        environment: HashMap<String, String>,
    ) -> Self {
        Self {
            executable,
            hostname,
            port,
            username,
            direct_probe_arguments,
            environment,
        }
    }
}

#[derive(Debug)]
pub(super) struct MultiplexControl {
    path: PathBuf,
    directory: PathBuf,
}

impl MultiplexControl {
    pub(super) fn master_arguments(&self) -> Vec<String> {
        vec![
            "-o".into(),
            "ControlMaster=auto".into(),
            "-o".into(),
            format!("ControlPath={}", self.path.to_string_lossy()),
            "-o".into(),
            "ControlPersist=10s".into(),
        ]
    }
}

impl Drop for MultiplexControl {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
        let _ = std::fs::remove_dir(&self.directory);
    }
}

#[cfg(unix)]
pub(super) fn prepare_multiplex_control() -> Option<Arc<MultiplexControl>> {
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::DirBuilderExt;

    for base in [std::env::temp_dir(), PathBuf::from("/tmp")] {
        let directory = base.join(format!("luma-ssh-{}", uuid::Uuid::new_v4()));
        let path = directory.join("control");
        if path.as_os_str().as_bytes().len() > CONTROL_PATH_MAX_BYTES
            || path.as_os_str().as_bytes().contains(&b'%')
        {
            continue;
        }

        let mut builder = std::fs::DirBuilder::new();
        builder.mode(0o700);
        if builder.create(&directory).is_ok() {
            return Some(Arc::new(MultiplexControl { path, directory }));
        }
    }

    None
}

#[cfg(not(unix))]
pub(super) fn prepare_multiplex_control() -> Option<Arc<MultiplexControl>> {
    None
}

pub(super) async fn detect_remote_os(
    target: RemoteOsTarget,
    control: Option<Arc<MultiplexControl>>,
) -> SshRemoteOs {
    let Some(control) = control else {
        return detect_without_multiplexing(&target).await;
    };

    if !multiplex_master_is_available(&target, &control).await {
        return SshRemoteOs::unknown();
    }

    match run_remote_command(&target, &control, &["cat", "/etc/os-release"]).await {
        Some((true, output)) => parse_os_release(&String::from_utf8_lossy(&output)),
        Some((false, _)) => detect_from_uname(&target, &control).await,
        None => SshRemoteOs::unknown(),
    }
}

async fn detect_without_multiplexing(target: &RemoteOsTarget) -> SshRemoteOs {
    match run_direct_remote_command(target, &["cat", "/etc/os-release"]).await {
        Some((true, output)) => parse_os_release(&String::from_utf8_lossy(&output)),
        Some((false, _)) => match run_direct_remote_command(target, &["uname", "-s"]).await {
            Some((true, output)) => normalize_uname(&String::from_utf8_lossy(&output)),
            _ => SshRemoteOs::unknown(),
        },
        None => SshRemoteOs::unknown(),
    }
}

async fn run_direct_remote_command(
    target: &RemoteOsTarget,
    remote_command: &[&str],
) -> Option<(bool, Vec<u8>)> {
    let mut arguments = target.direct_probe_arguments.clone();
    arguments.push(target.hostname.clone());
    arguments.extend(
        remote_command
            .iter()
            .map(|argument| (*argument).to_string()),
    );
    run_ssh(&target.executable, arguments, &target.environment).await
}

async fn detect_from_uname(target: &RemoteOsTarget, control: &MultiplexControl) -> SshRemoteOs {
    match run_remote_command(target, control, &["uname", "-s"]).await {
        Some((true, output)) => normalize_uname(&String::from_utf8_lossy(&output)),
        _ => SshRemoteOs::unknown(),
    }
}

async fn multiplex_master_is_available(
    target: &RemoteOsTarget,
    control: &MultiplexControl,
) -> bool {
    let mut arguments = control_arguments(target, control);
    arguments.push("-O".into());
    arguments.push("check".into());
    arguments.push(target.hostname.clone());
    run_ssh(&target.executable, arguments, &target.environment)
        .await
        .is_some_and(|(success, _)| success)
}

async fn run_remote_command(
    target: &RemoteOsTarget,
    control: &MultiplexControl,
    remote_command: &[&str],
) -> Option<(bool, Vec<u8>)> {
    run_ssh(
        &target.executable,
        remote_command_arguments(target, control, remote_command),
        &target.environment,
    )
    .await
}

fn remote_command_arguments(
    target: &RemoteOsTarget,
    control: &MultiplexControl,
    remote_command: &[&str],
) -> Vec<String> {
    let mut arguments = control_arguments(target, control);

    // If the master disappears between the control check and this command,
    // disable every authentication method so this helper cannot prompt for or
    // submit credentials on a new connection.
    for option in NO_REAUTH_OPTIONS {
        arguments.push("-o".into());
        arguments.push(option.into());
    }
    arguments.push(target.hostname.clone());
    arguments.extend(
        remote_command
            .iter()
            .map(|argument| (*argument).to_string()),
    );
    arguments
}

fn control_arguments(target: &RemoteOsTarget, control: &MultiplexControl) -> Vec<String> {
    let mut arguments = vec![
        "-S".into(),
        control.path.to_string_lossy().into_owned(),
        "-p".into(),
        target.port.to_string(),
    ];
    if let Some(username) = &target.username {
        arguments.push("-l".into());
        arguments.push(username.clone());
    }
    arguments
}

async fn run_ssh(
    executable: &str,
    arguments: Vec<String>,
    environment: &HashMap<String, String>,
) -> Option<(bool, Vec<u8>)> {
    let mut command = Command::new(executable);
    crate::platform::hide_background_tokio_command(&mut command);
    let mut child = command
        .args(arguments)
        .envs(environment)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .ok()?;
    let stdout = child.stdout.take()?;

    let operation = async {
        let mut output = Vec::new();
        let mut limited = stdout.take((MAX_DETECTION_OUTPUT_BYTES + 1) as u64);
        limited.read_to_end(&mut output).await.ok()?;
        if output.len() > MAX_DETECTION_OUTPUT_BYTES {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return None;
        }
        let status = child.wait().await.ok()?;
        Some((status.success(), output))
    };

    match timeout(DETECTION_TIMEOUT, operation).await {
        Ok(result) => result,
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            None
        }
    }
}

pub(super) fn parse_os_release(contents: &str) -> SshRemoteOs {
    let mut id = None;
    let mut id_like = None;
    let mut pretty_name = None;

    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, raw_value)) = line.split_once('=') else {
            continue;
        };
        let value = parse_os_release_value(raw_value);
        match key.trim() {
            "ID" => id = value,
            "ID_LIKE" => id_like = value,
            "PRETTY_NAME" => pretty_name = value,
            _ => {}
        }
    }

    let has_os_release_fields = id.is_some() || id_like.is_some() || pretty_name.is_some();
    if !has_os_release_fields {
        return SshRemoteOs::unknown();
    }

    let os_id = id
        .as_deref()
        .and_then(normalize_os_token)
        .or_else(|| {
            id_like
                .as_deref()
                .and_then(|value| value.split_whitespace().find_map(normalize_os_token))
        })
        .unwrap_or("linux");

    SshRemoteOs {
        os_id: os_id.into(),
        pretty_name: pretty_name.filter(|name| !name.is_empty()),
    }
}

fn parse_os_release_value(raw_value: &str) -> Option<String> {
    let value = raw_value.trim();
    if value.is_empty() {
        return Some(String::new());
    }

    let bytes = value.as_bytes();
    if matches!(bytes.first(), Some(b'\'') | Some(b'"')) {
        let quote = bytes[0];
        if bytes.len() < 2 || bytes.last().copied() != Some(quote) {
            return None;
        }
        let inner = &value[1..value.len() - 1];
        if quote == b'\'' {
            return Some(inner.to_string());
        }

        let mut parsed = String::with_capacity(inner.len());
        let mut escaped = false;
        for character in inner.chars() {
            if escaped {
                if matches!(character, '"' | '\\' | '$' | '`') {
                    parsed.push(character);
                } else {
                    parsed.push('\\');
                    parsed.push(character);
                }
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else {
                parsed.push(character);
            }
        }
        if escaped {
            parsed.push('\\');
        }
        return Some(parsed);
    }

    Some(value.to_string())
}

fn normalize_os_token(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "ubuntu" => Some("ubuntu"),
        "debian" => Some("debian"),
        "fedora" => Some("fedora"),
        "rhel" | "redhat" | "redhatenterpriseserver" => Some("rhel"),
        "centos" => Some("centos"),
        "rocky" | "rockylinux" => Some("rocky"),
        "almalinux" | "alma" => Some("almalinux"),
        "arch" | "archlinux" => Some("arch"),
        "manjaro" => Some("manjaro"),
        "alpine" => Some("alpine"),
        "opensuse" | "opensuse-leap" | "opensuse-tumbleweed" => Some("opensuse"),
        "suse" | "sles" | "sled" => Some("suse"),
        "linuxmint" | "mint" => Some("mint"),
        "kali" => Some("kali"),
        "gentoo" => Some("gentoo"),
        "void" | "voidlinux" => Some("void"),
        "nixos" => Some("nixos"),
        "amzn" | "amazon" | "amazonlinux" => Some("amazon"),
        "ol" | "oracle" | "oraclelinux" => Some("oracle"),
        "raspbian" => Some("raspbian"),
        "freebsd" => Some("freebsd"),
        "darwin" | "macos" | "osx" => Some("macos"),
        "windows" | "windows_nt" | "mingw" | "msys" | "cygwin" => Some("windows"),
        "linux" => Some("linux"),
        _ => None,
    }
}

pub(super) fn normalize_uname(value: &str) -> SshRemoteOs {
    let normalized = value.trim().to_ascii_lowercase();
    let os_id = if normalized == "linux" {
        "linux"
    } else if normalized.starts_with("freebsd") {
        "freebsd"
    } else if normalized == "darwin" {
        "macos"
    } else if normalized.contains("windows")
        || normalized.starts_with("mingw")
        || normalized.starts_with("msys")
        || normalized.starts_with("cygwin")
        || normalized == "windows_nt"
    {
        "windows"
    } else {
        "unknown"
    };

    SshRemoteOs {
        os_id: os_id.into(),
        pretty_name: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_normalizes_os_release_ids() {
        let cases = [
            (
                "ID=ubuntu\nPRETTY_NAME=\"Ubuntu 24.04 LTS\"\n",
                "ubuntu",
                Some("Ubuntu 24.04 LTS"),
            ),
            (
                "ID=raspbian\nPRETTY_NAME='Raspbian GNU/Linux 12'\n",
                "raspbian",
                Some("Raspbian GNU/Linux 12"),
            ),
            ("ID=pop\nID_LIKE=\"debian ubuntu\"\n", "debian", None),
            ("ID=rocky\nID_LIKE=\"rhel centos fedora\"\n", "rocky", None),
            (
                "ID=almalinux\nID_LIKE=\"rhel centos fedora\"\n",
                "almalinux",
                None,
            ),
            (
                "ID=custom-enterprise\nID_LIKE=\"rhel fedora\"\n",
                "rhel",
                None,
            ),
            ("ID=arch\n", "arch", None),
            ("ID=alpine\n", "alpine", None),
            ("ID=opensuse-leap\n", "opensuse", None),
            (
                "ID=unknown-distro\nPRETTY_NAME=\"Custom Linux\"\n",
                "linux",
                Some("Custom Linux"),
            ),
        ];

        for (input, expected_id, expected_pretty_name) in cases {
            let parsed = parse_os_release(input);
            assert_eq!(parsed.os_id, expected_id, "input: {input:?}");
            assert_eq!(
                parsed.pretty_name.as_deref(),
                expected_pretty_name,
                "input: {input:?}"
            );
        }
    }

    #[test]
    fn normalizes_uname_fallbacks() {
        let cases = [
            ("Darwin\n", "macos"),
            ("FreeBSD\n", "freebsd"),
            ("Linux\n", "linux"),
            ("MINGW64_NT-10.0\n", "windows"),
            ("Microsoft Windows [Version 10.0.26100.4652]\n", "windows"),
            ("Plan9\n", "unknown"),
        ];

        for (input, expected_id) in cases {
            assert_eq!(
                normalize_uname(input).os_id,
                expected_id,
                "input: {input:?}"
            );
        }
    }

    #[test]
    fn empty_and_garbage_os_release_are_unknown() {
        for input in ["", "\n# comment only\n", "not-an-assignment\ngarbage\n"] {
            assert_eq!(parse_os_release(input), SshRemoteOs::unknown());
        }
    }

    #[test]
    fn malformed_quoted_values_are_ignored() {
        let parsed = parse_os_release("ID=ubuntu\nPRETTY_NAME=\"unterminated\n");
        assert_eq!(parsed.os_id, "ubuntu");
        assert_eq!(parsed.pretty_name, None);
    }

    #[test]
    fn multiplex_remote_command_disables_all_reauthentication() {
        let target = RemoteOsTarget::new(
            "/usr/bin/ssh".into(),
            "server.example.com".into(),
            22,
            Some("alice".into()),
            Vec::new(),
            HashMap::new(),
        );
        let control = MultiplexControl {
            path: std::path::Path::new("/tmp/luma-control-test").to_path_buf(),
            directory: std::path::Path::new("/tmp/luma-control-test-dir").to_path_buf(),
        };
        let arguments = remote_command_arguments(&target, &control, &["cat", "/etc/os-release"]);

        for required in [
            "BatchMode=yes",
            "NumberOfPasswordPrompts=0",
            "PasswordAuthentication=no",
            "KbdInteractiveAuthentication=no",
            "PubkeyAuthentication=no",
            "HostbasedAuthentication=no",
            "GSSAPIAuthentication=no",
        ] {
            assert!(arguments.iter().any(|argument| argument == required));
        }
    }
}
