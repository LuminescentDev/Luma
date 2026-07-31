//! Remote multiplexer (tmux / zellij) workspace discovery and attach commands.
//!
//! Discovery runs one batched `sh -c` script over an SSH exec channel (same
//! convention as `server_stats` and `web_preview`) and parses its marked
//! sections in `parse.rs`.
//!
//! Attaching deliberately introduces no new backend session kind: the frontend
//! asks for `{ multiplexer, sessionName, create }`, and the attach command is
//! BUILT HERE from a validated session name and handed to the normal SSH spawn
//! as its startup command. The frontend never passes a command string, which
//! keeps the "frontend never spawns raw commands" invariant intact.

mod parse;

use std::time::Duration;

use russh::ChannelMsg;
use serde::Deserialize;
use sqlx::SqlitePool;

use crate::errors::{LumaError, Result};
use crate::keystore::KeystoreState;
use crate::ssh::{connection_config, validate_host_id, AuthenticatedConnection};

use parse::MAX_SESSION_NAME_LENGTH;
pub use parse::{MultiplexerDiscovery, MultiplexerKind};

/// Discovery is four cheap listings; a slow answer means a wedged connection.
const EXEC_TIMEOUT: Duration = Duration::from_secs(20);
/// Window listings dominate and stay tiny; the cap truncates rather than erroring.
const MAX_OUTPUT_BYTES: usize = 256 * 1024;

/// What the frontend may ask for when attaching. Note there is no command
/// field: only the multiplexer, a session name, and whether to create it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiplexerAttach {
    pub multiplexer: MultiplexerKind,
    pub session_name: String,
    #[serde(default)]
    pub create: bool,
}

/// Shell command that attaches to (or creates) the requested workspace.
///
/// The name is validated, never escaped: tmux/zellij session names are
/// user-chosen and simple in practice, so rejecting anything with shell
/// metacharacters is both safer and easier to reason about than quoting rules.
/// Because the validated name cannot contain a single quote, wrapping it in
/// single quotes is exact.
pub fn attach_command(request: &MultiplexerAttach) -> Result<String> {
    let name = validate_session_name(&request.session_name)?;
    Ok(match (request.multiplexer, request.create) {
        // -u forces UTF-8 regardless of the remote locale.
        (MultiplexerKind::Tmux, false) => format!("tmux -u attach -t '{name}'"),
        // -A makes create idempotent (attach when the name already exists),
        // matching zellij's `attach --create`. Resume-on-connect depends on it:
        // it must work whether or not the workspace survived.
        (MultiplexerKind::Tmux, true) => format!("tmux -u new -A -s '{name}'"),
        (MultiplexerKind::Zellij, false) => format!("zellij attach '{name}'"),
        (MultiplexerKind::Zellij, true) => format!("zellij attach --create '{name}'"),
    })
}

/// The one character a single-quoted argument cannot carry.
///
/// The command is delivered as a single `exec` request, so the remote login
/// shell parses it exactly once and single quotes suppress every other
/// metacharacter. Rejecting more than this would list workspaces (discovery
/// only drops control characters) that could never be attached — tmux names
/// like `feat/#123` or `build[2]` are ordinary.
const FORBIDDEN_NAME_CHARACTERS: &[char] = &['\'', '\u{7f}'];

fn validate_session_name(name: &str) -> Result<&str> {
    let length = name.chars().count();
    if length == 0 || length > MAX_SESSION_NAME_LENGTH {
        return Err(LumaError::InvalidInput(format!(
            "workspace name must be 1-{MAX_SESSION_NAME_LENGTH} characters"
        )));
    }
    if name.chars().any(char::is_control) {
        return Err(LumaError::InvalidInput(
            "workspace name must not contain control characters".into(),
        ));
    }
    if name.chars().any(|c| FORBIDDEN_NAME_CHARACTERS.contains(&c)) {
        return Err(LumaError::InvalidInput(
            "workspace name must not contain a single quote".into(),
        ));
    }
    if name.starts_with('-') || name.trim() != name {
        return Err(LumaError::InvalidInput(
            "workspace name must not start with '-' or have surrounding spaces".into(),
        ));
    }
    Ok(name)
}

/// Enumerate tmux/zellij workspaces on a host. Availability is reported
/// separately from sessions so the UI can say "tmux is not installed" instead
/// of "no workspaces".
pub async fn list(
    pool: &SqlitePool,
    keystore_state: &KeystoreState,
    host_id: &str,
) -> Result<MultiplexerDiscovery> {
    validate_host_id(host_id)?;
    let (mut config, _) = connection_config(pool, keystore_state, host_id).await?;
    // Discovery is an exec channel, never the host's interactive startup command.
    config.startup_command = None;
    let connection = crate::ssh::authenticated_handle(&config).await?;
    let output = run_discovery_script(&connection).await;
    let _ = connection
        .disconnect(
            russh::Disconnect::ByApplication,
            "multiplexer discovery done",
            "en",
        )
        .await;
    Ok(parse::parse_discovery(&output?))
}

/// Builds the batched discovery script. Sections are marked with
/// `===LUMA:<name>===`; stderr is silenced so a missing multiplexer degrades to
/// an empty section. Single line and free of single quotes, so it survives any
/// remote login shell inside `sh -c '...'`.
///
/// The TAB separating tmux fields is produced by the remote shell (`$T`) rather
/// than written as `\t` in the format string: tmux does not expand backslash
/// escapes in `-F`, so a literal `\t` would come back verbatim.
fn discovery_script() -> String {
    const TMUX_SESSION_FIELDS: &[&str] = &[
        "#{session_name}",
        "#{session_windows}",
        "#{session_attached}",
        "#{session_activity}",
        "#{session_created}",
    ];
    const TMUX_WINDOW_FIELDS: &[&str] = &[
        "#{session_name}",
        "#{window_index}",
        "#{window_name}",
        "#{window_panes}",
        "#{window_active}",
    ];
    let sections: [(&str, String); 4] = [
        (
            "avail",
            "command -v tmux >/dev/null && echo tmux; command -v zellij >/dev/null && echo zellij"
                .to_string(),
        ),
        (
            "tmuxsessions",
            format!(
                "tmux list-sessions -F \"{}\"",
                TMUX_SESSION_FIELDS.join("${T}")
            ),
        ),
        (
            "tmuxwindows",
            format!(
                "tmux list-windows -a -F \"{}\"",
                TMUX_WINDOW_FIELDS.join("${T}")
            ),
        ),
        (
            // Older zellij has no --no-formatting; fall back to the colored
            // form, which the parser strips escapes from.
            "zellij",
            "zellij list-sessions --no-formatting || zellij list-sessions".to_string(),
        ),
    ];
    let mut body = String::from("exec 2>/dev/null; T=$(printf \"\\t\")");
    for (name, command) in &sections {
        body.push_str(&format!(r#"; printf "\n===LUMA:{name}===\n"; "#));
        body.push_str(command);
    }
    debug_assert!(!body.contains('\''));
    format!("sh -c '{body}'")
}

async fn run_discovery_script(connection: &AuthenticatedConnection) -> Result<String> {
    let operation = async {
        let mut channel = connection
            .channel_open_session()
            .await
            .map_err(exec_error)?;
        channel
            .exec(true, discovery_script().as_bytes())
            .await
            .map_err(exec_error)?;
        let mut output = Vec::new();
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => {
                    let remaining = MAX_OUTPUT_BYTES.saturating_sub(output.len());
                    output.extend_from_slice(&data[..data.len().min(remaining)]);
                }
                ChannelMsg::Eof | ChannelMsg::Close => break,
                _ => {}
            }
        }
        Ok(String::from_utf8_lossy(&output).into_owned())
    };
    tokio::time::timeout(EXEC_TIMEOUT, operation)
        .await
        .map_err(|_| LumaError::SshConnection {
            category: "timeout",
            message: "multiplexer discovery timed out".into(),
        })?
}

fn exec_error(error: russh::Error) -> LumaError {
    LumaError::SshConnection {
        category: "ssh-error",
        message: format!("multiplexer discovery exec failed: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attach(multiplexer: MultiplexerKind, session_name: &str, create: bool) -> Result<String> {
        attach_command(&MultiplexerAttach {
            multiplexer,
            session_name: session_name.to_string(),
            create,
        })
    }

    #[test]
    fn script_is_single_line_and_single_quote_free() {
        let script = discovery_script();
        assert!(script.starts_with("sh -c '"));
        assert!(script.ends_with('\''));
        assert!(!script.contains('\n'));
        let body = &script["sh -c '".len()..script.len() - 1];
        assert!(!body.contains('\''));
        for section in ["avail", "tmuxsessions", "tmuxwindows", "zellij"] {
            assert!(
                script.contains(&format!("===LUMA:{section}===")),
                "{section}"
            );
        }
        // The TAB must come from the shell, not from a literal \t that tmux
        // would echo back verbatim.
        assert!(body.contains("T=$(printf \"\\t\")"));
        assert!(body.contains("#{session_name}${T}#{session_windows}"));
        assert!(body.contains("#{session_name}${T}#{window_index}"));
    }

    #[test]
    fn builds_attach_and_create_commands() {
        assert_eq!(
            attach(MultiplexerKind::Tmux, "main", false).unwrap(),
            "tmux -u attach -t 'main'"
        );
        assert_eq!(
            attach(MultiplexerKind::Tmux, "my project", true).unwrap(),
            "tmux -u new -A -s 'my project'"
        );
        assert_eq!(
            attach(MultiplexerKind::Zellij, "dashing-cat", false).unwrap(),
            "zellij attach 'dashing-cat'"
        );
        assert_eq!(
            attach(MultiplexerKind::Zellij, "dashing-cat", true).unwrap(),
            "zellij attach --create 'dashing-cat'"
        );
    }

    #[test]
    fn rejects_names_that_would_break_out_of_the_quotes() {
        for name in ["a'b", "a'; rm -rf /; '", "'"] {
            assert!(
                attach(MultiplexerKind::Tmux, name, false).is_err(),
                "{name} should be rejected"
            );
        }
    }

    #[test]
    fn accepts_metacharacters_that_single_quotes_neutralize() {
        // Discovery lists these, so attaching to them must work; the single
        // quotes around the name make them inert to the remote shell.
        for name in [
            "feat/#123",
            "build[2]",
            "a\"b",
            "a`b`",
            "a$b",
            "a\\b",
            "a;rm -rf /",
            "a&b",
            "a|b",
            "a>b",
            "a(b)",
            "a{b}",
            "a*b",
            "a!b",
            "a~b",
            "a=b",
            "a%b",
        ] {
            let command = attach(MultiplexerKind::Tmux, name, false)
                .unwrap_or_else(|_| panic!("{name} should be accepted"));
            assert_eq!(command, format!("tmux -u attach -t '{name}'"));
        }
    }

    #[test]
    fn rejects_empty_overlong_and_control_names() {
        assert!(attach(MultiplexerKind::Tmux, "", false).is_err());
        assert!(attach(
            MultiplexerKind::Tmux,
            &"x".repeat(MAX_SESSION_NAME_LENGTH + 1),
            false
        )
        .is_err());
        assert!(attach(
            MultiplexerKind::Zellij,
            &"x".repeat(MAX_SESSION_NAME_LENGTH),
            false
        )
        .is_ok());
        assert!(attach(MultiplexerKind::Tmux, "bad\nname", false).is_err());
        assert!(attach(MultiplexerKind::Tmux, "bad\tname", false).is_err());
        assert!(attach(MultiplexerKind::Tmux, "bad\u{7}name", false).is_err());
    }

    #[test]
    fn rejects_option_lookalikes_and_padded_names() {
        assert!(attach(MultiplexerKind::Tmux, "-t", false).is_err());
        assert!(attach(MultiplexerKind::Tmux, " main", false).is_err());
        assert!(attach(MultiplexerKind::Tmux, "main ", false).is_err());
    }

    #[test]
    fn accepts_ordinary_names() {
        for name in ["main", "my project", "web.dev", "a_b-c", "0", "café"] {
            assert!(
                attach(MultiplexerKind::Zellij, name, false).is_ok(),
                "{name} should be accepted"
            );
        }
    }
}
