//! Mosh transport support. The bootstrap runs `mosh-server new` over the
//! host's existing embedded-SSH configuration (mirroring server_stats' exec
//! pattern), parses the `MOSH CONNECT <port> <key>` reply, and the desktop
//! then launches a local `mosh-client` through the normal PTY infrastructure.
//!
//! The session key is a secret: it is handed to mosh-client via the process
//! environment only, never logged and never exposed to the frontend.

use crate::errors::{LumaError, Result};

/// Transport preferences a host may store. "ssh" is the default and the
/// current behavior; "auto" tries Mosh and falls back to SSH (frontend-side);
/// "mosh" is Mosh-only.
pub const TRANSPORTS: [&str; 3] = ["ssh", "auto", "mosh"];

const MAX_SERVER_PATH_LENGTH: usize = 1024;
/// A mosh session key is 16 bytes, base64-encoded without padding: 22 chars.
const MOSH_KEY_LENGTH: usize = 22;

pub fn validate_transport(value: &str) -> Result<()> {
    if !TRANSPORTS.contains(&value) {
        return Err(LumaError::InvalidInput(
            "transport must be 'ssh', 'auto', or 'mosh'".into(),
        ));
    }
    Ok(())
}

/// Validate a custom remote mosh-server path. The path is later concatenated
/// into a remote shell command line, so the character set is strict: no
/// whitespace, no quotes, no shell metacharacters of any kind.
pub fn validate_server_path(path: &str) -> Result<()> {
    if path.is_empty() || path.len() > MAX_SERVER_PATH_LENGTH {
        return Err(LumaError::InvalidInput(format!(
            "mosh-server path must be 1-{MAX_SERVER_PATH_LENGTH} characters"
        )));
    }
    if path.starts_with('-') {
        return Err(LumaError::InvalidInput(
            "mosh-server path must not start with '-'".into(),
        ));
    }
    if !path.chars().all(|character| {
        character.is_ascii_alphanumeric() || matches!(character, '/' | '.' | '-' | '_' | '+' | '~')
    }) {
        return Err(LumaError::InvalidInput(
            "mosh-server path contains whitespace, quotes, or shell metacharacters".into(),
        ));
    }
    Ok(())
}

/// Parse and validate a UDP port range: "N" or "N-M" with 1 <= N <= M <= 65535.
pub fn validate_port_range(range: &str) -> Result<(u16, u16)> {
    let invalid = || {
        LumaError::InvalidInput(
            "mosh port range must be a port or 'low-high' with ports between 1 and 65535".into(),
        )
    };
    let (low, high) = match range.split_once('-') {
        Some((low, high)) => (low, high),
        None => (range, range),
    };
    let parse = |value: &str| value.parse::<u16>().ok().filter(|port| *port >= 1);
    let low = parse(low).ok_or_else(invalid)?;
    let high = parse(high).ok_or_else(invalid)?;
    if low > high {
        return Err(invalid());
    }
    Ok((low, high))
}

/// Build the remote bootstrap command. Both inputs are re-validated here so the
/// resulting argv-in-a-string is safe to hand to the remote shell: the server
/// path character set excludes quoting/metacharacters entirely and the port
/// range is rendered from parsed integers (mosh-server takes `-p low:high`).
pub fn bootstrap_command(server_path: Option<&str>, port_range: Option<&str>) -> Result<String> {
    let path = server_path.unwrap_or("mosh-server");
    validate_server_path(path)?;
    let mut command = format!("{path} new -s -c 256 -l LANG=en_US.UTF-8");
    if let Some(range) = port_range {
        let (low, high) = validate_port_range(range)?;
        command.push_str(&format!(" -p {low}:{high}"));
    }
    debug_assert!(!command.contains(['\'', '"', '\n', ';', '|', '&', '$', '`']));
    Ok(command)
}

fn parse_connect_line(line: &str) -> Option<(u16, String)> {
    let rest = line.trim().strip_prefix("MOSH CONNECT ")?;
    let mut parts = rest.split_whitespace();
    let port = parts
        .next()?
        .parse::<u16>()
        .ok()
        .filter(|port| *port >= 1)?;
    let key = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    if key.len() != MOSH_KEY_LENGTH
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/'))
    {
        return None;
    }
    Some((port, key.to_string()))
}

/// Find the `MOSH CONNECT <port> <key>` line in the bootstrap output. Returns
/// the UDP port and the session key. The key MUST never be logged.
pub fn parse_mosh_connect(output: &str) -> Option<(u16, String)> {
    output.lines().find_map(parse_connect_line)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod client {
    use std::path::PathBuf;
    use std::time::Duration;

    use russh::ChannelMsg;

    use super::parse_mosh_connect;
    use crate::errors::{LumaError, Result};
    use crate::ssh::AuthenticatedConnection;

    /// mosh-server prints its CONNECT line immediately after forking; a slow
    /// answer means a wedged connection, not a busy server.
    const BOOTSTRAP_TIMEOUT: Duration = Duration::from_secs(30);
    const MAX_OUTPUT_BYTES: usize = 64 * 1024;
    /// How much remote output to echo back in a bootstrap diagnostic.
    const MAX_DIAGNOSTIC_BYTES: usize = 300;

    pub struct MoshBootstrap {
        pub udp_port: u16,
        /// The mosh session key. Secret: environment-only, never logged.
        pub key: String,
    }

    /// Locate a local mosh-client binary. The frontend never supplies this
    /// path: it is resolved backend-side from PATH plus the common install
    /// locations that GUI apps on macOS do not inherit in PATH.
    pub fn find_mosh_client() -> Option<PathBuf> {
        let binary = if cfg!(windows) {
            "mosh-client.exe"
        } else {
            "mosh-client"
        };
        let mut directories: Vec<PathBuf> = std::env::var_os("PATH")
            .map(|path| std::env::split_paths(&path).collect())
            .unwrap_or_default();
        directories.extend(
            ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
                .iter()
                .map(PathBuf::from),
        );
        directories
            .into_iter()
            .filter(|directory| !directory.as_os_str().is_empty())
            .map(|directory| directory.join(binary))
            .find(|candidate| candidate.is_file())
    }

    pub fn missing_client_error() -> LumaError {
        LumaError::SshConnection {
            category: "mosh-client-missing",
            message: "mosh-client was not found on this machine. Install mosh locally \
                      (e.g. `brew install mosh` or your distribution's mosh package) \
                      to use the Mosh transport."
                .into(),
        }
    }

    /// Resolve the address mosh-client should target: the first resolved IP for
    /// the host (preferring IPv4), falling back to the hostname itself. The UDP
    /// path always goes direct — through a proxy jump only the SSH bootstrap is
    /// tunneled, so an unreachable host simply fails to connect.
    pub async fn resolve_target(hostname: &str, port: u16) -> String {
        let Ok(addresses) = tokio::net::lookup_host((hostname, port)).await else {
            return hostname.to_string();
        };
        let addresses: Vec<_> = addresses.collect();
        addresses
            .iter()
            .find(|address| address.is_ipv4())
            .or_else(|| addresses.first())
            .map(|address| address.ip().to_string())
            .unwrap_or_else(|| hostname.to_string())
    }

    fn append_capped(buffer: &mut Vec<u8>, data: &[u8]) {
        let remaining = MAX_OUTPUT_BYTES.saturating_sub(buffer.len());
        buffer.extend_from_slice(&data[..data.len().min(remaining)]);
    }

    fn exec_error(error: russh::Error) -> LumaError {
        LumaError::SshConnection {
            category: "mosh-bootstrap-failed",
            message: format!("mosh bootstrap exec failed: {error}"),
        }
    }

    /// A short, key-free snippet of remote output for diagnostics. Any line
    /// starting with "MOSH CONNECT" is dropped so a malformed connect line can
    /// never leak (part of) a session key into an error message or log.
    fn diagnostic_snippet(stdout: &str, stderr: &str) -> String {
        let mut snippet: String = stderr
            .lines()
            .chain(stdout.lines())
            .map(str::trim)
            .filter(|line| !line.is_empty() && !line.starts_with("MOSH CONNECT"))
            .collect::<Vec<_>>()
            .join(" | ");
        snippet.truncate(snippet.floor_char_boundary(MAX_DIAGNOSTIC_BYTES));
        snippet
    }

    /// Run the bootstrap command over an exec channel on an authenticated SSH
    /// connection and parse the `MOSH CONNECT` reply.
    pub async fn bootstrap(
        connection: &AuthenticatedConnection,
        command: &str,
    ) -> Result<MoshBootstrap> {
        let operation = async {
            let mut channel = connection
                .channel_open_session()
                .await
                .map_err(exec_error)?;
            channel
                .exec(true, command.as_bytes())
                .await
                .map_err(exec_error)?;
            let mut stdout = Vec::new();
            let mut stderr = Vec::new();
            let mut exit_code = None;
            while let Some(message) = channel.wait().await {
                match message {
                    ChannelMsg::Data { data } => append_capped(&mut stdout, &data),
                    ChannelMsg::ExtendedData { data, ext: 1 } => append_capped(&mut stderr, &data),
                    ChannelMsg::ExitStatus { exit_status } => exit_code = Some(exit_status),
                    ChannelMsg::Eof | ChannelMsg::Close => break,
                    _ => {}
                }
            }
            Ok::<_, LumaError>((
                String::from_utf8_lossy(&stdout).into_owned(),
                String::from_utf8_lossy(&stderr).into_owned(),
                exit_code,
            ))
        };
        let (stdout, stderr, exit_code) = tokio::time::timeout(BOOTSTRAP_TIMEOUT, operation)
            .await
            .map_err(|_| LumaError::SshConnection {
                category: "mosh-bootstrap-failed",
                message: "mosh bootstrap timed out waiting for mosh-server".into(),
            })??;

        if let Some((udp_port, key)) = parse_mosh_connect(&stdout) {
            return Ok(MoshBootstrap { udp_port, key });
        }

        let combined = format!("{stdout}\n{stderr}").to_ascii_lowercase();
        if exit_code == Some(127)
            || combined.contains("not found")
            || combined.contains("no such file")
        {
            return Err(LumaError::SshConnection {
                category: "mosh-server-missing",
                message: "mosh-server not found on the remote host. Install mosh on the \
                          server, or set a custom mosh-server path in the host settings."
                    .into(),
            });
        }
        let snippet = diagnostic_snippet(&stdout, &stderr);
        let detail = if snippet.is_empty() {
            String::new()
        } else {
            format!(" Remote output: {snippet}.")
        };
        Err(LumaError::SshConnection {
            category: "mosh-bootstrap-failed",
            message: format!(
                "mosh-server did not report a session (no MOSH CONNECT line).{detail} \
                 Note that Mosh needs direct UDP reachability: a stalled connection \
                 usually means UDP is blocked, and proxy-jump hosts only tunnel the \
                 SSH bootstrap."
            ),
        })
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub use client::{bootstrap, find_mosh_client, missing_client_error, resolve_target};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_transport_values() {
        for valid in TRANSPORTS {
            assert!(validate_transport(valid).is_ok(), "{valid}");
        }
        for invalid in ["", "telnet", "SSH", "auto ", "mosh-only"] {
            assert!(validate_transport(invalid).is_err(), "accepted {invalid:?}");
        }
    }

    #[test]
    fn validates_port_ranges() {
        assert_eq!(validate_port_range("60000-61000").unwrap(), (60000, 61000));
        assert_eq!(validate_port_range("60001").unwrap(), (60001, 60001));
        assert_eq!(validate_port_range("1-65535").unwrap(), (1, 65535));
        for invalid in [
            "",
            "0",
            "65536",
            "-",
            "60000-",
            "-61000",
            "61000-60000",
            "60000:61000",
            "60000-61000-62000",
            "abc",
            "60000 - 61000",
        ] {
            assert!(
                validate_port_range(invalid).is_err(),
                "accepted {invalid:?}"
            );
        }
    }

    #[test]
    fn builds_bootstrap_commands() {
        assert_eq!(
            bootstrap_command(None, None).unwrap(),
            "mosh-server new -s -c 256 -l LANG=en_US.UTF-8"
        );
        assert_eq!(
            bootstrap_command(Some("/opt/local/bin/mosh-server"), Some("60000-61000")).unwrap(),
            "/opt/local/bin/mosh-server new -s -c 256 -l LANG=en_US.UTF-8 -p 60000:61000"
        );
        assert_eq!(
            bootstrap_command(Some("~/bin/mosh-server"), Some("60005")).unwrap(),
            "~/bin/mosh-server new -s -c 256 -l LANG=en_US.UTF-8 -p 60005:60005"
        );
    }

    #[test]
    fn rejects_injection_via_server_path() {
        for invalid in [
            "",
            "-rf",
            "mosh-server; rm -rf /",
            "mosh-server&&reboot",
            "mosh server",
            "mosh-server'",
            "mosh-server\"",
            "mosh-server`id`",
            "mosh-server$(id)",
            "mosh-server|cat",
            "mosh-server\nrm",
            "mosh-server>out",
        ] {
            assert!(
                bootstrap_command(Some(invalid), None).is_err(),
                "accepted {invalid:?}"
            );
        }
    }

    #[test]
    fn parses_mosh_connect_lines() {
        let output = "some banner\r\nMOSH CONNECT 60001 4NeCCgvZFe2RnPgrcU1PQw\ntrailing";
        let (port, key) = parse_mosh_connect(output).unwrap();
        assert_eq!(port, 60001);
        assert_eq!(key, "4NeCCgvZFe2RnPgrcU1PQw");
    }

    #[test]
    fn rejects_garbage_and_missing_connect_lines() {
        for output in [
            "",
            "welcome to the server",
            "MOSH CONNECT",
            "MOSH CONNECT 60001",
            // Port out of range / zero.
            "MOSH CONNECT 0 4NeCCgvZFe2RnPgrcU1PQw",
            "MOSH CONNECT 70000 4NeCCgvZFe2RnPgrcU1PQw",
            // Key too short, too long, or with an invalid charset.
            "MOSH CONNECT 60001 shortkey",
            "MOSH CONNECT 60001 4NeCCgvZFe2RnPgrcU1PQww",
            "MOSH CONNECT 60001 4NeCCgvZFe2RnPgrcU1P'w",
            // Extra trailing token on the line.
            "MOSH CONNECT 60001 4NeCCgvZFe2RnPgrcU1PQw extra",
        ] {
            assert!(parse_mosh_connect(output).is_none(), "accepted {output:?}");
        }
        // A garbage line must not mask a valid one later in the output.
        let mixed = "MOSH CONNECT bad line\nMOSH CONNECT 61000 AAAAAAAAAAAAAAAAAAAAAA";
        assert_eq!(
            parse_mosh_connect(mixed).unwrap(),
            (61000, "AAAAAAAAAAAAAAAAAAAAAA".to_string())
        );
    }
}
