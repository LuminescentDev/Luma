//! Agentless Docker view: lists containers, reads their stats, logs and
//! configuration, and performs the three reversible lifecycle actions
//! (start / stop / restart) over the host's existing SSH configuration.
//!
//! Like `server_stats`, `web_preview`, `multiplexer` and `repository`, every
//! call runs one batched shell script through an exec channel and parses
//! `===LUMA:<name>===` sections out of the result. Connections are cached per
//! host because a listing is normally followed by a stats fetch, a log tail and
//! an inspect in quick succession.
//!
//! # Why the script is base64-encoded as a whole
//!
//! The sibling features embed their script body directly in a `sh -c '…'`
//! wrapper, which only works while the body contains no single quote. This one
//! cannot: every docker command asks for `--format '{{json .}}'`, and the Go
//! template has to survive the remote shell intact. So the ENTIRE inner script
//! is base64-encoded here and the wrapper becomes
//!
//! ```text
//! sh -c 'B=<BASE64>; S=$(printf %s "$B" | base64 -d); …; printf %s "$S" | sh'
//! ```
//!
//! Base64 output only ever uses `A-Za-z0-9+/=`, so the payload cannot contain a
//! quote, `$`, backtick or newline and the single-quoted wrapper is exact by
//! construction — the same argument `repository` makes for its path arguments,
//! applied one level further out. The inner script is then free to use quotes,
//! braces and templates however it likes.
//!
//! # Untrusted values
//!
//! The only value that comes from the frontend is a container identifier. It is
//! validated to `[A-Za-z0-9_.-]{1,128}` (docker's own name/id alphabet) AND
//! base64-encoded into the inner script, where it is decoded into a shell
//! variable and only ever used double-quoted (`docker logs "$C"`). Both, not
//! either: the character allow-list makes the value uninteresting even if the
//! encoding were bypassed, and the encoding makes the shell treat it as data
//! even if the allow-list were widened later. Actions are a closed enum, so the
//! subcommand is always a Rust literal and never user text.

mod parse;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use russh::ChannelMsg;
use sqlx::SqlitePool;

use crate::errors::{LumaError, Result};
use crate::keystore::KeystoreState;
use crate::ssh::{
    connection_config, validate_host_id, AuthenticatedConnection, SshConnectionConfig,
};

pub use parse::{DockerActionResult, DockerInspect, DockerList, DockerLogs, DockerStat};

/// Whole-script budget. `docker ps` and `docker inspect` are instant; `docker
/// stats --no-stream` samples twice and takes a couple of seconds; a
/// start/stop/restart may legitimately wait out the container's stop grace
/// period, which defaults to 10s.
const EXEC_TIMEOUT: Duration = Duration::from_secs(45);
/// Transport cap. Payloads are already capped remotely; base64 inflates them by
/// 4/3 plus line wrapping, so this leaves comfortable headroom.
const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
/// Largest listing / stats / inspect payload accepted from the remote host.
const MAX_PAYLOAD_BYTES: usize = 1024 * 1024;
/// Largest log tail handed to the frontend. A tail bigger than this is unusable
/// in a dialog and expensive to ship over the channel.
const MAX_LOG_BYTES: usize = 512 * 1024;
/// Largest accepted `tail` request, whatever the frontend asks for.
const MAX_LOG_LINES: u32 = 5_000;
/// Longest accepted container name or id. Docker names are far shorter and a
/// full id is 64 hex characters.
const MAX_CONTAINER_LENGTH: usize = 128;
/// Trimmed action output is a line or two; anything longer is docker being
/// unusually chatty and is cut.
const MAX_ACTION_OUTPUT_BYTES: usize = 8 * 1024;

/// The three lifecycle actions this feature is allowed to perform. Every one is
/// reversible from the same dialog, which is the whole reason the set is this
/// small — see the module docs on `docker_action` in `commands/docker.rs`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DockerAction {
    Start,
    Stop,
    Restart,
}

impl DockerAction {
    /// Parses the action name from the frontend. Anything outside the set is
    /// rejected rather than passed through as a docker subcommand.
    pub fn parse(action: &str) -> Result<Self> {
        match action {
            "start" => Ok(Self::Start),
            "stop" => Ok(Self::Stop),
            "restart" => Ok(Self::Restart),
            _ => Err(LumaError::InvalidInput(format!(
                "unsupported docker action: {action}"
            ))),
        }
    }

    /// The docker subcommand. Always a literal — never interpolated user text.
    fn subcommand(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::Stop => "stop",
            Self::Restart => "restart",
        }
    }
}

struct CachedConnection {
    connection: AuthenticatedConnection,
    // Keeps any ephemeral identity file alive for the lifetime of the
    // connection, mirroring SftpManager, ServerStatsManager and
    // RepositoryManager.
    _config: SshConnectionConfig,
}

/// Holds one authenticated SSH connection per host so the listing and the
/// stats / logs / inspect calls that follow it reuse a session instead of
/// re-handshaking.
#[derive(Default)]
pub struct DockerManager {
    connections: Mutex<HashMap<String, Arc<CachedConnection>>>,
}

impl DockerManager {
    /// Every container on the host (running or not), grouped by Compose project.
    /// A host without a usable docker is not an error: `available` is false and
    /// `unavailable_reason` says which of the three common causes it is.
    pub async fn list(
        &self,
        pool: &SqlitePool,
        keystore_state: &KeystoreState,
        host_id: &str,
    ) -> Result<DockerList> {
        validate_host_id(host_id)?;
        let output = self
            .run(pool, keystore_state, host_id, list_script())
            .await?;
        let sections = crate::server_stats::split_sections(&output);
        let section = |name: &str| sections.get(name).map(String::as_str).unwrap_or("");
        let docker_present = section("which").trim() == "1";
        let exit_code = parse_exit_code(section("code"));
        let (payload, _) = cap_text(decode_section(section("ps")), MAX_PAYLOAD_BYTES);

        if let Some(reason) = parse::classify_unavailable(docker_present, exit_code, &payload) {
            return Ok(DockerList {
                available: false,
                unavailable_reason: Some(reason.to_string()),
                containers: Vec::new(),
                projects: Vec::new(),
            });
        }
        let containers = parse::parse_containers(&payload);
        let projects = parse::group_projects(&containers);
        Ok(DockerList {
            available: true,
            unavailable_reason: None,
            containers,
            projects,
        })
    }

    /// Live CPU and memory for the running containers. Separate from `list`
    /// because `docker stats --no-stream` samples twice and takes seconds, so
    /// the UI asks for it on demand rather than on every refresh.
    pub async fn stats(
        &self,
        pool: &SqlitePool,
        keystore_state: &KeystoreState,
        host_id: &str,
    ) -> Result<Vec<DockerStat>> {
        validate_host_id(host_id)?;
        let output = self
            .run(pool, keystore_state, host_id, stats_script())
            .await?;
        let sections = crate::server_stats::split_sections(&output);
        let section = |name: &str| sections.get(name).map(String::as_str).unwrap_or("");
        if parse_exit_code(section("code")) != 0 {
            // Docker answered the listing a moment ago, so a failure here is
            // transient (daemon restarting, container vanishing mid-sample).
            // An empty result reads as "no stats yet" in the UI.
            return Ok(Vec::new());
        }
        let (payload, _) = cap_text(decode_section(section("stats")), MAX_PAYLOAD_BYTES);
        Ok(parse::parse_stats(&payload))
    }

    /// Last `tail` lines of one container's combined output, timestamped.
    pub async fn logs(
        &self,
        pool: &SqlitePool,
        keystore_state: &KeystoreState,
        host_id: &str,
        container: &str,
        tail: u32,
    ) -> Result<DockerLogs> {
        validate_host_id(host_id)?;
        let container = validate_container(container)?;
        let tail = tail.clamp(1, MAX_LOG_LINES);
        let output = self
            .run(pool, keystore_state, host_id, logs_script(container, tail))
            .await?;
        let sections = crate::server_stats::split_sections(&output);
        let Some(raw) = sections.get("logs") else {
            return Err(script_failed("could not read the container logs"));
        };
        let (lines, truncated) = cap_text(decode_section(raw), MAX_LOG_BYTES);
        Ok(DockerLogs { lines, truncated })
    }

    /// Configuration of one container, with secret-looking environment values
    /// already replaced in Rust (see `parse::redact_env`).
    pub async fn inspect(
        &self,
        pool: &SqlitePool,
        keystore_state: &KeystoreState,
        host_id: &str,
        container: &str,
    ) -> Result<DockerInspect> {
        validate_host_id(host_id)?;
        let container = validate_container(container)?;
        let output = self
            .run(pool, keystore_state, host_id, inspect_script(container))
            .await?;
        let sections = crate::server_stats::split_sections(&output);
        let section = |name: &str| sections.get(name).map(String::as_str).unwrap_or("");
        let (payload, _) = cap_text(decode_section(section("inspect")), MAX_PAYLOAD_BYTES);
        parse::parse_inspect(&payload)
            .ok_or_else(|| script_failed("could not inspect the container; it may no longer exist"))
    }

    /// Starts, stops or restarts one container. The action is a closed enum and
    /// the container identifier is validated and base64-passed, so the remote
    /// command is `docker <literal> "$C"` and nothing else.
    pub async fn action(
        &self,
        pool: &SqlitePool,
        keystore_state: &KeystoreState,
        host_id: &str,
        container: &str,
        action: DockerAction,
    ) -> Result<DockerActionResult> {
        validate_host_id(host_id)?;
        let container = validate_container(container)?;
        let output = self
            .run(
                pool,
                keystore_state,
                host_id,
                action_script(container, action),
            )
            .await?;
        let sections = crate::server_stats::split_sections(&output);
        let section = |name: &str| sections.get(name).map(String::as_str).unwrap_or("");
        let exit_code = parse_exit_code(section("code"));
        let (text, _) = cap_text(decode_section(section("output")), MAX_ACTION_OUTPUT_BYTES);
        tracing::info!(
            host_id = %host_id,
            action = action.subcommand(),
            exit_code,
            "ran docker container action"
        );
        Ok(DockerActionResult {
            success: exit_code == 0,
            exit_code,
            output: text.trim().to_string(),
        })
    }

    pub async fn close(&self, host_id: &str) -> Result<()> {
        validate_host_id(host_id)?;
        if let Some(cached) = self.remove(host_id) {
            let _ = cached
                .connection
                .disconnect(russh::Disconnect::ByApplication, "docker closed", "en")
                .await;
            tracing::info!(host_id = %host_id, "closed docker connection");
        }
        Ok(())
    }

    pub fn kill_all(&self) {
        let count = {
            let mut connections = self.connections.lock().unwrap();
            let count = connections.len();
            connections.clear();
            count
        };
        if count > 0 {
            tracing::info!(count, "dropped docker connections on shutdown");
        }
    }

    /// Runs one script on the host's cached connection, reconnecting once if the
    /// cached session died since the previous call.
    async fn run(
        &self,
        pool: &SqlitePool,
        keystore_state: &KeystoreState,
        host_id: &str,
        script: String,
    ) -> Result<String> {
        let (cached, was_cached) = self.get_or_connect(pool, keystore_state, host_id).await?;
        match run_script(&cached.connection, &script).await {
            Ok(output) => Ok(output),
            Err(error) => {
                self.remove(host_id);
                if !was_cached {
                    return Err(error);
                }
                let (fresh, _) = self.get_or_connect(pool, keystore_state, host_id).await?;
                match run_script(&fresh.connection, &script).await {
                    Ok(output) => Ok(output),
                    Err(retry_error) => {
                        self.remove(host_id);
                        Err(retry_error)
                    }
                }
            }
        }
    }

    async fn get_or_connect(
        &self,
        pool: &SqlitePool,
        keystore_state: &KeystoreState,
        host_id: &str,
    ) -> Result<(Arc<CachedConnection>, bool)> {
        if let Some(cached) = self.connections.lock().unwrap().get(host_id) {
            return Ok((Arc::clone(cached), true));
        }
        let (mut config, _) = connection_config(pool, keystore_state, host_id).await?;
        // Docker reads are exec channels, never the host's interactive startup
        // command.
        config.startup_command = None;
        let connection = crate::ssh::authenticated_handle(&config).await?;
        let cached = Arc::new(CachedConnection {
            connection,
            _config: config,
        });
        let mut connections = self.connections.lock().unwrap();
        // A concurrent call may have connected first; keep the existing one.
        let entry = Arc::clone(
            connections
                .entry(host_id.to_string())
                .or_insert_with(|| Arc::clone(&cached)),
        );
        drop(connections);
        tracing::info!(host_id = %host_id, "opened docker connection");
        Ok((entry, false))
    }

    fn remove(&self, host_id: &str) -> Option<Arc<CachedConnection>> {
        self.connections.lock().unwrap().remove(host_id)
    }
}

// --- Validation -------------------------------------------------------------

/// A container name or id from the frontend. Docker's own name alphabet is
/// `[a-zA-Z0-9][a-zA-Z0-9_.-]*` and ids are hex, so this allow-list accepts
/// everything docker can address while rejecting every shell metacharacter,
/// whitespace, quote, control character and leading dash (which would otherwise
/// be read as an option).
fn validate_container(container: &str) -> Result<&str> {
    if container.is_empty() || container.len() > MAX_CONTAINER_LENGTH {
        return Err(LumaError::InvalidInput(format!(
            "container must be 1-{MAX_CONTAINER_LENGTH} characters"
        )));
    }
    if container.starts_with('-') {
        return Err(LumaError::InvalidInput(
            "container must not start with a dash".into(),
        ));
    }
    if !container
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
    {
        return Err(LumaError::InvalidInput(
            "container may only contain letters, digits, and _ . -".into(),
        ));
    }
    Ok(container)
}

// --- Script construction ----------------------------------------------------

/// Wraps an inner script so the remote login shell — of unknown flavour — sees
/// nothing but base64 inside the single quotes. See the module docs.
fn wrap(inner: &str) -> String {
    let payload = STANDARD.encode(inner);
    debug_assert!(
        !payload.contains('\'') && !payload.contains('\n'),
        "base64 payload must be quote- and newline-free"
    );
    // `-d` is GNU/busybox, `-D` is older BSD/macOS; try both, as `repository`
    // does for its argument decoding.
    format!(
        "sh -c 'B={payload}; \
         S=$(printf %s \"$B\" | base64 -d 2>/dev/null); \
         [ -n \"$S\" ] || S=$(printf %s \"$B\" | base64 -D 2>/dev/null); \
         printf %s \"$S\" | sh'"
    )
}

/// Decoder for a base64 ARGUMENT inside the inner script, same shape as the
/// wrapper's own fallback.
const DECODE_FN: &str = "X(){ R=$(printf %s \"$1\" | base64 -d 2>/dev/null); \
                         [ -n \"$R\" ] || R=$(printf %s \"$1\" | base64 -D 2>/dev/null); \
                         printf %s \"$R\"; }; ";

fn section(name: &str) -> String {
    format!("printf \"\\n===LUMA:{name}===\\n\"; ")
}

/// Decodes the container identifier into `$C` and refuses to continue if the
/// remote `base64` produced nothing.
fn container_prelude(container: &str) -> String {
    format!(
        "{DECODE_FN}C=$(X \"{}\"); [ -n \"$C\" ] || exit 5; ",
        STANDARD.encode(container)
    )
}

/// `command -v docker` for availability, then the listing itself. Output and
/// exit status are captured together in a command substitution so the exit code
/// belongs to docker rather than to the tail of a pipeline (`PIPESTATUS` is a
/// bashism this cannot rely on). On failure the captured text IS docker's
/// diagnosis, which is what `classify_unavailable` reads.
fn list_script() -> String {
    let cap = MAX_PAYLOAD_BYTES + 1;
    let mut body = String::from("if command -v docker >/dev/null 2>&1; then W=1; else W=0; fi; ");
    body.push_str("O=$(docker ps -a --no-trunc --format \"{{json .}}\" 2>&1); E=$?; ");
    body.push_str(&section("which"));
    body.push_str("printf %s \"$W\"; ");
    body.push_str(&section("code"));
    body.push_str("printf %s \"$E\"; ");
    body.push_str(&section("ps"));
    body.push_str(&format!("printf %s \"$O\" | head -c {cap} | base64"));
    wrap(&body)
}

fn stats_script() -> String {
    let cap = MAX_PAYLOAD_BYTES + 1;
    let mut body =
        String::from("O=$(docker stats --no-stream --format \"{{json .}}\" 2>&1); E=$?; ");
    body.push_str(&section("code"));
    body.push_str("printf %s \"$E\"; ");
    body.push_str(&section("stats"));
    body.push_str(&format!("printf %s \"$O\" | head -c {cap} | base64"));
    wrap(&body)
}

/// `2>&1` merges the container's stderr into the tail, which is what a reader
/// expects from a log view — and also means docker's own "No such container"
/// lands in the pane instead of vanishing.
fn logs_script(container: &str, tail: u32) -> String {
    // One byte past the cap so a payload that fills it is reported as truncated
    // rather than silently ending mid-line.
    let cap = MAX_LOG_BYTES + 1;
    let mut body = container_prelude(container);
    body.push_str(&section("logs"));
    body.push_str(&format!(
        "docker logs --tail {tail} --timestamps \"$C\" 2>&1 | head -c {cap} | base64"
    ));
    wrap(&body)
}

fn inspect_script(container: &str) -> String {
    let cap = MAX_PAYLOAD_BYTES + 1;
    let mut body = container_prelude(container);
    body.push_str("O=$(docker inspect \"$C\" 2>&1); E=$?; ");
    body.push_str(&section("code"));
    body.push_str("printf %s \"$E\"; ");
    body.push_str(&section("inspect"));
    body.push_str(&format!("printf %s \"$O\" | head -c {cap} | base64"));
    wrap(&body)
}

fn action_script(container: &str, action: DockerAction) -> String {
    let cap = MAX_ACTION_OUTPUT_BYTES + 1;
    let subcommand = action.subcommand();
    let mut body = container_prelude(container);
    body.push_str(&format!("O=$(docker {subcommand} \"$C\" 2>&1); E=$?; "));
    body.push_str(&section("code"));
    body.push_str("printf %s \"$E\"; ");
    body.push_str(&section("output"));
    body.push_str(&format!("printf %s \"$O\" | head -c {cap} | base64"));
    wrap(&body)
}

// --- Output handling --------------------------------------------------------

/// Decodes a base64 section, ignoring the line wrapping `base64(1)` applies. A
/// section that is not valid base64 is passed through verbatim: that only
/// happens when the remote `base64` misbehaved, and showing its raw output beats
/// showing nothing.
fn decode_section(section: &str) -> Vec<u8> {
    let compact: String = section
        .chars()
        .filter(|c| !c.is_ascii_whitespace())
        .collect();
    if compact.is_empty() {
        return Vec::new();
    }
    STANDARD
        .decode(compact)
        .unwrap_or_else(|_| section.as_bytes().to_vec())
}

/// Caps a payload, reporting whether it was cut. Lossy conversion also repairs
/// the partial UTF-8 sequence a byte-wise cut can leave.
fn cap_text(bytes: Vec<u8>, limit: usize) -> (String, bool) {
    let truncated = bytes.len() > limit;
    let slice = if truncated {
        &bytes[..limit]
    } else {
        &bytes[..]
    };
    (String::from_utf8_lossy(slice).into_owned(), truncated)
}

/// The `code` section holds `$?`. A missing or unparseable section means the
/// script never got that far, which is itself a failure.
fn parse_exit_code(section: &str) -> i32 {
    section.trim().parse().unwrap_or(-1)
}

// --- Exec channel -----------------------------------------------------------

async fn run_script(connection: &AuthenticatedConnection, script: &str) -> Result<String> {
    let operation = async {
        let mut channel = connection
            .channel_open_session()
            .await
            .map_err(exec_error)?;
        channel
            .exec(true, script.as_bytes())
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
            message: "docker command timed out".into(),
        })?
}

fn exec_error(error: russh::Error) -> LumaError {
    LumaError::SshConnection {
        category: "ssh-error",
        message: format!("docker exec failed: {error}"),
    }
}

/// The script bailed out before printing a section it always prints.
fn script_failed(what: &str) -> LumaError {
    LumaError::SshConnection {
        category: "ssh-error",
        message: what.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE64_ALPHABET: &str =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";

    fn body_of(script: &str) -> &str {
        assert!(script.starts_with("sh -c '"), "{script}");
        assert!(script.ends_with('\''), "{script}");
        &script["sh -c '".len()..script.len() - 1]
    }

    /// Decodes the wrapped payload back into the inner script.
    fn inner_of(script: &str) -> String {
        let body = body_of(script);
        let payload = body
            .strip_prefix("B=")
            .and_then(|rest| rest.split(';').next())
            .expect("payload assignment");
        String::from_utf8(STANDARD.decode(payload).expect("valid base64")).unwrap()
    }

    /// Every script must survive an arbitrary login shell inside `sh -c '...'`.
    fn assert_wrapper_intact(script: &str) {
        let body = body_of(script);
        assert!(
            !body.contains('\''),
            "body must be single-quote free: {body}"
        );
        assert!(!body.contains('\n'), "body must be one line: {body}");
    }

    // --- Wrapper safety ------------------------------------------------------

    #[test]
    fn every_script_is_wrapped_in_a_quote_free_base64_payload() {
        for script in [
            list_script(),
            stats_script(),
            logs_script("web", 100),
            inspect_script("web"),
            action_script("web", DockerAction::Restart),
        ] {
            assert_wrapper_intact(&script);
            let payload = body_of(&script)
                .strip_prefix("B=")
                .and_then(|rest| rest.split(';').next())
                .expect("payload assignment");
            assert!(
                payload.chars().all(|c| BASE64_ALPHABET.contains(c)),
                "payload must use only the base64 alphabet: {payload}"
            );
            // Both decoder spellings are attempted for BSD/macOS hosts.
            assert!(body_of(&script).contains("base64 -d"));
            assert!(body_of(&script).contains("base64 -D"));
        }
    }

    /// The reason the whole-script encoding exists: the Go template `{{json .}}`
    /// carries a space and braces, and the format flag needs quoting that the
    /// old `sh -c '<body>'` shape could not provide.
    #[test]
    fn the_json_format_template_survives_into_the_inner_script() {
        let inner = inner_of(&list_script());
        assert!(inner.contains("docker ps -a --no-trunc --format \"{{json .}}\""));
        assert!(
            inner_of(&stats_script()).contains("docker stats --no-stream --format \"{{json .}}\"")
        );
    }

    #[test]
    fn the_listing_probes_availability_and_reports_the_exit_code() {
        let inner = inner_of(&list_script());
        assert!(inner.contains("command -v docker"));
        for name in ["which", "code", "ps"] {
            assert!(inner.contains(&format!("===LUMA:{name}===")), "{name}");
        }
        // stderr is folded into the captured output so the failure text is
        // available for classification.
        assert!(inner.contains("2>&1"));
        assert!(inner.contains("E=$?"));
    }

    // --- Container identifiers ----------------------------------------------

    #[test]
    fn container_identifiers_accept_docker_names_and_ids() {
        for name in [
            "web",
            "shop_api_1",
            "shop-api-1",
            "my.container",
            "a",
            "0",
            "3f2a9c1b4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8",
            &"x".repeat(MAX_CONTAINER_LENGTH),
        ] {
            assert!(
                validate_container(name).is_ok(),
                "{name} should be accepted"
            );
        }
    }

    #[test]
    fn container_identifiers_reject_injection_attempts() {
        for name in [
            "",
            " ",
            "web db",
            "web;rm -rf /",
            "web && rm -rf /",
            "web|cat /etc/shadow",
            "$(id)",
            "`id`",
            "web$IFS",
            "web'x",
            "web\"x",
            "web\nrm -rf /",
            "web\0",
            "web\\x",
            "../etc/passwd",
            "web/../x",
            "-f",
            "--format={{.Config}}",
            "web>out",
            "web&",
            "café",
            &"x".repeat(MAX_CONTAINER_LENGTH + 1),
        ] {
            assert!(
                validate_container(name).is_err(),
                "{name:?} should be rejected"
            );
        }
    }

    /// Even the accepted alphabet never reaches the script literally: it is
    /// decoded into `$C` and only ever used double-quoted.
    #[test]
    fn container_identifiers_reach_the_script_as_base64_only() {
        let name = "shop_api-1.web";
        for script in [
            logs_script(name, 500),
            inspect_script(name),
            action_script(name, DockerAction::Stop),
        ] {
            assert_wrapper_intact(&script);
            let inner = inner_of(&script);
            assert!(
                !inner.contains(name),
                "raw container name leaked into the script: {inner}"
            );
            assert!(inner.contains(&STANDARD.encode(name)));
            assert!(inner.contains("C=$(X \""));
            // Never unquoted, never an option position.
            assert!(inner.contains("\"$C\""));
            assert!(!inner.contains(" $C"));
        }
    }

    // --- Per-script shape ----------------------------------------------------

    #[test]
    fn the_log_script_tails_with_timestamps_and_caps_the_payload() {
        let inner = inner_of(&logs_script("web", 2000));
        assert!(inner.contains("docker logs --tail 2000 --timestamps \"$C\" 2>&1"));
        assert!(inner.contains(&format!("head -c {}", MAX_LOG_BYTES + 1)));
        assert!(inner.contains("===LUMA:logs==="));
    }

    #[test]
    fn the_tail_size_is_clamped_before_it_reaches_the_script() {
        // `logs` clamps; verify the clamp itself rather than the network path.
        assert_eq!(0u32.clamp(1, MAX_LOG_LINES), 1);
        assert_eq!(u32::MAX.clamp(1, MAX_LOG_LINES), MAX_LOG_LINES);
        assert_eq!(500u32.clamp(1, MAX_LOG_LINES), 500);
    }

    #[test]
    fn the_action_script_uses_a_literal_subcommand() {
        for (action, expected) in [
            (DockerAction::Start, "docker start \"$C\""),
            (DockerAction::Stop, "docker stop \"$C\""),
            (DockerAction::Restart, "docker restart \"$C\""),
        ] {
            let inner = inner_of(&action_script("web", action));
            assert!(inner.contains(expected), "{inner}");
            assert!(inner.contains("===LUMA:code==="));
            assert!(inner.contains("===LUMA:output==="));
        }
    }

    #[test]
    fn only_the_three_reversible_actions_parse() {
        assert_eq!(DockerAction::parse("start").unwrap(), DockerAction::Start);
        assert_eq!(DockerAction::parse("stop").unwrap(), DockerAction::Stop);
        assert_eq!(
            DockerAction::parse("restart").unwrap(),
            DockerAction::Restart
        );
        // Destructive or unsupported subcommands are refused outright, so no
        // docker verb outside the set can ever be constructed.
        for action in [
            "rm",
            "kill",
            "pause",
            "prune",
            "exec",
            "run",
            "stop;rm",
            "Start",
            "START",
            "",
            "-f",
            "compose up",
        ] {
            assert!(DockerAction::parse(action).is_err(), "{action:?}");
        }
    }

    // --- Output handling -----------------------------------------------------

    #[test]
    fn sections_decode_through_base64_line_wrapping() {
        let payload = b"{\"ID\":\"a\"}\n{\"ID\":\"b\"}\n";
        let encoded = STANDARD.encode(payload);
        let wrapped = format!("{}\n{}\n", &encoded[..4], &encoded[4..]);
        assert_eq!(decode_section(&wrapped), payload);
        assert_eq!(decode_section(""), Vec::<u8>::new());
        assert_eq!(decode_section("  \n "), Vec::<u8>::new());
        // Not base64 at all: passed through rather than lost.
        assert_eq!(decode_section("!!nope!!"), b"!!nope!!".to_vec());
    }

    #[test]
    fn payloads_are_capped_and_flagged() {
        let (text, truncated) = cap_text(b"short".to_vec(), MAX_LOG_BYTES);
        assert_eq!(text, "short");
        assert!(!truncated);

        let (text, truncated) = cap_text(vec![b'x'; MAX_LOG_BYTES + 10], MAX_LOG_BYTES);
        assert_eq!(text.len(), MAX_LOG_BYTES);
        assert!(truncated);

        // A cut through a multi-byte character must not produce invalid UTF-8.
        let mut oversized = "é".repeat(MAX_LOG_BYTES).into_bytes();
        oversized.truncate(MAX_LOG_BYTES + 1);
        let (text, truncated) = cap_text(oversized, MAX_LOG_BYTES);
        assert!(truncated);
        assert!(text.chars().count() <= MAX_LOG_BYTES);
    }

    #[test]
    fn a_missing_exit_code_section_reads_as_failure() {
        assert_eq!(parse_exit_code("0\n"), 0);
        assert_eq!(parse_exit_code(" 125 "), 125);
        assert_eq!(parse_exit_code(""), -1);
        assert_eq!(parse_exit_code("not a number"), -1);
    }
}
