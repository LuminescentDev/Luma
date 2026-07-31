//! Pure parsers for the remote docker script output.
//!
//! Everything docker is asked for is requested as `--format '{{json .}}'` (one
//! self-describing JSON object per line) or as `docker inspect`'s JSON array,
//! rather than the human table format. Column tables shift between docker
//! releases and cannot be split reliably once a status string contains the
//! separator; a JSON line either parses or is skipped.
//!
//! Nothing in here fails: a malformed line is dropped, a missing field falls
//! back to a default, and unknown extra fields are ignored, so a newer docker
//! that adds columns keeps working against an older Luma.

use serde::{Deserialize, Serialize};

/// Upper bound on containers turned into rows. A host with more than this is
/// not browsable in a dialog; the excess is dropped rather than shipped.
pub(crate) const MAX_CONTAINERS: usize = 2_000;

/// Compose labels docker writes on every container it creates from a project.
const LABEL_PROJECT: &str = "com.docker.compose.project";
const LABEL_SERVICE: &str = "com.docker.compose.service";

/// Placeholder substituted for any environment value whose key looks secret.
/// Six bullets, so the length never hints at the real value.
pub(crate) const REDACTED: &str = "••••••";

/// Substrings that mark an environment KEY as secret-bearing. Matched
/// case-insensitively against the whole key, so `DB_PASSWORD`, `apiKey` and
/// `GITHUB_TOKEN` all hit. Deliberately over-broad — `MONKEY_COUNT` matching
/// "key" costs a hidden value, while a miss would print a credential.
///
/// Key matching alone is not enough: `DATABASE_URL` and `SENTRY_DSN` name no
/// secret but routinely carry one in their value, so `has_embedded_credentials`
/// covers the connection-string shape as well.
const SECRET_MARKERS: [&str; 14] = [
    "pass",
    "pwd",
    "secret",
    "token",
    "key",
    "credential",
    "auth",
    "private",
    "salt",
    "signature",
    "dsn",
    "cookie",
    "session",
    "otp",
];

// --- Wire types --------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DockerContainer {
    /// Full (untruncated) container id; `docker ps` is run with `--no-trunc`.
    pub id: String,
    /// First name docker reports. A container can have several; the rest are
    /// aliases that address the same thing.
    pub name: String,
    pub image: String,
    /// Normalised lifecycle state: "running" | "exited" | "paused" |
    /// "restarting" | "created" | "removing" | "dead" | "unknown".
    pub state: String,
    /// Human status text, e.g. "Up 3 hours" or "Exited (0) 2 days ago".
    pub status: String,
    /// Port mapping summary exactly as docker prints it.
    pub ports: String,
    pub created_at: String,
    /// Compose project from `com.docker.compose.project`; `None` when the
    /// container was not created by Compose.
    pub project: Option<String>,
    pub service: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DockerProject {
    /// `None` is the catch-all bucket for containers with no Compose labels.
    pub name: Option<String>,
    pub containers: Vec<DockerContainer>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DockerList {
    /// The docker CLI ran and answered. False means `unavailable_reason` says
    /// why, and both lists are empty.
    pub available: bool,
    /// "docker not installed" | "permission denied" | "daemon not running" |
    /// "docker command failed"; `None` when available.
    pub unavailable_reason: Option<String>,
    /// Flat list in docker's own order.
    pub containers: Vec<DockerContainer>,
    /// The same containers grouped by Compose project, ungrouped bucket last.
    pub projects: Vec<DockerProject>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DockerStat {
    /// Short id as `docker stats` reports it — NOT comparable to the
    /// `--no-trunc` id from `docker ps` without a prefix match, which is why
    /// `name` is carried alongside for the frontend to join on.
    pub id: String,
    pub name: String,
    /// `None` when docker printed something unparseable (e.g. "--").
    pub cpu_percent: Option<f64>,
    /// Raw "123.4MiB / 2GiB" text; the units are docker's, not ours to guess.
    pub mem_usage: String,
    pub mem_percent: Option<f64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DockerLogs {
    pub lines: String,
    /// The tail hit the byte cap and the START of it was cut.
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EnvVar {
    pub key: String,
    /// Already replaced with `REDACTED` when `redacted` is true — the real
    /// value never leaves the Rust side.
    pub value: String,
    pub redacted: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DockerMount {
    /// "bind" | "volume" | "tmpfs" as docker classifies it.
    pub kind: String,
    pub source: String,
    pub destination: String,
    pub rw: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PortBinding {
    /// Container side, e.g. "80/tcp".
    pub container: String,
    /// Host side, e.g. "0.0.0.0:8080"; empty when the port is exposed but not
    /// published.
    pub host: String,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DockerInspect {
    pub name: String,
    pub image: String,
    pub state: String,
    pub started_at: Option<String>,
    pub restart_count: u32,
    pub restart_policy: Option<String>,
    pub command: Option<String>,
    pub env: Vec<EnvVar>,
    pub mounts: Vec<DockerMount>,
    pub ports: Vec<PortBinding>,
    pub networks: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DockerActionResult {
    pub success: bool,
    pub exit_code: i32,
    /// Trimmed combined stdout/stderr — docker echoes the container name on
    /// success and a one-line reason on failure.
    pub output: String,
}

// --- `docker ps --format '{{json .}}'` --------------------------------------

/// One `docker ps` line. Every field defaults, because `State` only exists from
/// docker 20.10 and a future release may drop or rename others. Unknown fields
/// are ignored by serde, so extra columns are harmless.
#[derive(Debug, Default, Deserialize)]
struct RawContainer {
    #[serde(rename = "ID", default)]
    id: String,
    #[serde(rename = "Names", default)]
    names: String,
    #[serde(rename = "Image", default)]
    image: String,
    #[serde(rename = "State", default)]
    state: String,
    #[serde(rename = "Status", default)]
    status: String,
    #[serde(rename = "Ports", default)]
    ports: String,
    #[serde(rename = "CreatedAt", default)]
    created_at: String,
    /// Comma-separated `k=v` pairs, NOT a nested object.
    #[serde(rename = "Labels", default)]
    labels: String,
}

/// Parses the `{{json .}}` lines of `docker ps -a`. Blank and malformed lines
/// are skipped so one bad record never costs the whole listing.
pub(crate) fn parse_containers(output: &str) -> Vec<DockerContainer> {
    let mut containers = Vec::new();
    for line in output.lines() {
        if containers.len() >= MAX_CONTAINERS {
            break;
        }
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(raw) = serde_json::from_str::<RawContainer>(line) else {
            continue;
        };
        let (project, service) = compose_labels(&raw.labels);
        containers.push(DockerContainer {
            id: raw.id,
            // Docker joins multiple names with a comma; the first is the one
            // every command accepts.
            name: raw
                .names
                .split(',')
                .next()
                .unwrap_or_default()
                .trim()
                .trim_start_matches('/')
                .to_string(),
            image: raw.image,
            state: normalise_state(&raw.state, &raw.status),
            status: raw.status,
            ports: raw.ports,
            created_at: raw.created_at,
            project,
            service,
        });
    }
    containers
}

/// Pulls the Compose project/service out of the flat label string. Values are
/// taken as-is; docker escapes nothing here, so a label value containing a comma
/// would split — Compose project names cannot contain one.
fn compose_labels(labels: &str) -> (Option<String>, Option<String>) {
    let mut project = None;
    let mut service = None;
    for pair in labels.split(',') {
        let Some((key, value)) = pair.split_once('=') else {
            continue;
        };
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        match key.trim() {
            LABEL_PROJECT => project = Some(value.to_string()),
            LABEL_SERVICE => service = Some(value.to_string()),
            _ => {}
        }
    }
    (project, service)
}

/// Docker's `State` column is already a lowercase keyword, but it is missing on
/// older daemons — there the human `Status` text is the only signal.
fn normalise_state(state: &str, status: &str) -> String {
    let state = state.trim().to_ascii_lowercase();
    if !state.is_empty() {
        return state;
    }
    let status = status.trim().to_ascii_lowercase();
    if status.starts_with("up") {
        // "Up 2 hours (Paused)" is a running container that is suspended.
        if status.contains("paused") {
            return "paused".into();
        }
        return "running".into();
    }
    for (prefix, name) in [
        ("exited", "exited"),
        ("created", "created"),
        ("restarting", "restarting"),
        ("removal", "removing"),
        ("dead", "dead"),
    ] {
        if status.starts_with(prefix) {
            return name.into();
        }
    }
    "unknown".into()
}

/// Groups containers by Compose project, preserving docker's ordering both
/// between projects (first appearance wins) and inside one. Containers without
/// Compose labels collect in a single trailing `None` bucket so the UI can list
/// hand-started containers after the projects.
pub(crate) fn group_projects(containers: &[DockerContainer]) -> Vec<DockerProject> {
    let mut projects: Vec<DockerProject> = Vec::new();
    let mut ungrouped: Vec<DockerContainer> = Vec::new();
    for container in containers {
        let Some(name) = container.project.clone() else {
            ungrouped.push(container.clone());
            continue;
        };
        match projects
            .iter_mut()
            .find(|project| project.name.as_deref() == Some(name.as_str()))
        {
            Some(project) => project.containers.push(container.clone()),
            None => projects.push(DockerProject {
                name: Some(name),
                containers: vec![container.clone()],
            }),
        }
    }
    if !ungrouped.is_empty() {
        projects.push(DockerProject {
            name: None,
            containers: ungrouped,
        });
    }
    projects
}

// --- Availability ------------------------------------------------------------

/// Turns the probe into a reason the user can act on. `output` is the combined
/// stdout/stderr of `docker ps`, which is where docker puts its diagnosis.
///
/// Ordering matters: the permission failure a non-root user outside the `docker`
/// group hits ("Got permission denied while trying to connect to the Docker
/// daemon socket") also mentions connecting to the daemon, so it has to be
/// tested before the daemon-down patterns.
pub(crate) fn classify_unavailable(
    docker_present: bool,
    exit_code: i32,
    output: &str,
) -> Option<&'static str> {
    if !docker_present {
        return Some("docker not installed");
    }
    if exit_code == 0 {
        return None;
    }
    let output = output.to_ascii_lowercase();
    if output.contains("permission denied") || output.contains("permission_denied") {
        return Some("permission denied");
    }
    if output.contains("cannot connect to the docker daemon")
        || output.contains("is the docker daemon running")
        || output.contains("docker daemon is not running")
        || output.contains("error during connect")
    {
        return Some("daemon not running");
    }
    if output.contains("not found") || output.contains("no such file or directory") {
        return Some("docker not installed");
    }
    Some("docker command failed")
}

// --- `docker stats --format '{{json .}}'` -----------------------------------

#[derive(Debug, Default, Deserialize)]
struct RawStat {
    #[serde(rename = "ID", default)]
    id: String,
    #[serde(rename = "Name", default)]
    name: String,
    #[serde(rename = "CPUPerc", default)]
    cpu_perc: String,
    #[serde(rename = "MemUsage", default)]
    mem_usage: String,
    #[serde(rename = "MemPerc", default)]
    mem_perc: String,
}

pub(crate) fn parse_stats(output: &str) -> Vec<DockerStat> {
    let mut stats = Vec::new();
    for line in output.lines() {
        if stats.len() >= MAX_CONTAINERS {
            break;
        }
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(raw) = serde_json::from_str::<RawStat>(line) else {
            continue;
        };
        stats.push(DockerStat {
            id: raw.id,
            name: raw.name.trim().trim_start_matches('/').to_string(),
            cpu_percent: parse_percent(&raw.cpu_perc),
            mem_usage: raw.mem_usage,
            mem_percent: parse_percent(&raw.mem_perc),
        });
    }
    stats
}

/// "12.34%" → 12.34. A stopped container reports "--", which is not a number
/// and correctly becomes `None`.
fn parse_percent(value: &str) -> Option<f64> {
    value.trim().trim_end_matches('%').trim().parse().ok()
}

// --- `docker inspect` --------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
struct RawInspect {
    #[serde(rename = "Name", default)]
    name: String,
    #[serde(rename = "RestartCount", default)]
    restart_count: u32,
    #[serde(rename = "Config", default)]
    config: RawConfig,
    #[serde(rename = "State", default)]
    state: RawState,
    #[serde(rename = "HostConfig", default)]
    host_config: RawHostConfig,
    #[serde(rename = "Mounts", default)]
    mounts: Vec<RawMount>,
    #[serde(rename = "NetworkSettings", default)]
    network_settings: RawNetworkSettings,
}

#[derive(Debug, Default, Deserialize)]
struct RawConfig {
    #[serde(rename = "Image", default)]
    image: String,
    #[serde(rename = "Env", default)]
    env: Vec<String>,
    #[serde(rename = "Cmd", default)]
    cmd: Option<Vec<String>>,
}

#[derive(Debug, Default, Deserialize)]
struct RawState {
    #[serde(rename = "Status", default)]
    status: String,
    #[serde(rename = "StartedAt", default)]
    started_at: String,
}

#[derive(Debug, Default, Deserialize)]
struct RawHostConfig {
    #[serde(rename = "RestartPolicy", default)]
    restart_policy: RawRestartPolicy,
}

#[derive(Debug, Default, Deserialize)]
struct RawRestartPolicy {
    #[serde(rename = "Name", default)]
    name: String,
}

#[derive(Debug, Default, Deserialize)]
struct RawMount {
    #[serde(rename = "Type", default)]
    kind: String,
    #[serde(rename = "Source", default)]
    source: String,
    #[serde(rename = "Name", default)]
    name: String,
    #[serde(rename = "Destination", default)]
    destination: String,
    #[serde(rename = "RW", default)]
    rw: bool,
}

#[derive(Debug, Default, Deserialize)]
struct RawNetworkSettings {
    /// `{"80/tcp": [{"HostIp": "0.0.0.0", "HostPort": "8080"}], "443/tcp": null}`
    #[serde(rename = "Ports", default)]
    ports: std::collections::BTreeMap<String, Option<Vec<RawPortBinding>>>,
    #[serde(rename = "Networks", default)]
    networks: std::collections::BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Default, Deserialize)]
struct RawPortBinding {
    #[serde(rename = "HostIp", default)]
    host_ip: String,
    #[serde(rename = "HostPort", default)]
    host_port: String,
}

/// Parses `docker inspect`'s JSON array (one element, since exactly one
/// container is ever inspected) and redacts secret-looking environment values
/// on the way through. `None` when the payload is not the expected array.
pub(crate) fn parse_inspect(output: &str) -> Option<DockerInspect> {
    let raws: Vec<RawInspect> = serde_json::from_str(output.trim()).ok()?;
    let raw = raws.into_iter().next()?;
    let mounts = raw
        .mounts
        .into_iter()
        .map(|mount| DockerMount {
            kind: mount.kind,
            // A named volume has no host path worth showing; its name is the
            // identity the user recognises.
            source: if mount.source.is_empty() {
                mount.name
            } else {
                mount.source
            },
            destination: mount.destination,
            rw: mount.rw,
        })
        .collect();
    let ports = raw
        .network_settings
        .ports
        .into_iter()
        .map(|(container, bindings)| PortBinding {
            container,
            host: bindings
                .unwrap_or_default()
                .into_iter()
                .map(|binding| {
                    if binding.host_ip.is_empty() {
                        binding.host_port
                    } else {
                        format!("{}:{}", binding.host_ip, binding.host_port)
                    }
                })
                .collect::<Vec<_>>()
                .join(", "),
        })
        .collect();
    Some(DockerInspect {
        name: raw.name.trim_start_matches('/').to_string(),
        image: raw.config.image,
        state: raw.state.status,
        started_at: Some(raw.state.started_at).filter(|value| !value.is_empty()),
        restart_count: raw.restart_count,
        restart_policy: Some(raw.host_config.restart_policy.name).filter(|value| !value.is_empty()),
        command: raw
            .config
            .cmd
            .filter(|cmd| !cmd.is_empty())
            .map(|cmd| cmd.join(" ")),
        env: redact_env(&raw.config.env),
        mounts,
        ports,
        networks: raw.network_settings.networks.into_keys().collect(),
    })
}

/// Splits `KEY=VALUE` strings and blanks out anything whose key looks like it
/// names a credential. This runs in Rust, before the value is serialised, so a
/// redacted secret is never in the IPC payload, the frontend's memory, or a
/// devtools inspection of it.
///
/// An EMPTY value is left empty rather than replaced: there is no secret to
/// hide, and showing `••••••` for an unset variable would misrepresent the
/// container's configuration.
pub(crate) fn redact_env(env: &[String]) -> Vec<EnvVar> {
    env.iter()
        .map(|entry| {
            let (key, value) = match entry.split_once('=') {
                Some((key, value)) => (key.to_string(), value.to_string()),
                // A bare name with no "=" cannot carry a value.
                None => (entry.clone(), String::new()),
            };
            let redacted =
                !value.is_empty() && (is_secret_key(&key) || has_embedded_credentials(&value));
            EnvVar {
                key,
                value: if redacted {
                    REDACTED.to_string()
                } else {
                    value
                },
                redacted,
            }
        })
        .collect()
}

fn is_secret_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    SECRET_MARKERS.iter().any(|marker| key.contains(marker))
}

/// Whether a value looks like a URL carrying credentials in its userinfo, e.g.
/// `postgres://user:hunter2@db:5432/app`. The whole value is redacted rather
/// than just the password: partial rewriting risks leaking through the cases it
/// does not anticipate, and the variable's presence is still visible.
fn has_embedded_credentials(value: &str) -> bool {
    let Some((_, rest)) = value.split_once("://") else {
        return false;
    };
    // Userinfo lives in the authority, before the path/query/fragment.
    let authority = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    match authority.rsplit_once('@') {
        Some((userinfo, _)) => userinfo.contains(':'),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn container_line(name: &str, state: &str, labels: &str) -> String {
        format!(
            r#"{{"ID":"abc{name}","Names":"{name}","Image":"nginx:1.25","State":"{state}","Status":"Up 3 hours","Ports":"0.0.0.0:80->80/tcp","CreatedAt":"2026-01-01 10:00:00 +0000 UTC","Labels":"{labels}"}}"#
        )
    }

    // --- `{{json .}}` line parsing ------------------------------------------

    #[test]
    fn parses_one_json_object_per_line() {
        let output = format!(
            "{}\n{}\n",
            container_line("web", "running", ""),
            container_line("db", "exited", "")
        );
        let containers = parse_containers(&output);
        assert_eq!(containers.len(), 2);
        assert_eq!(containers[0].name, "web");
        assert_eq!(containers[0].id, "abcweb");
        assert_eq!(containers[0].image, "nginx:1.25");
        assert_eq!(containers[0].state, "running");
        assert_eq!(containers[0].status, "Up 3 hours");
        assert_eq!(containers[0].ports, "0.0.0.0:80->80/tcp");
        assert_eq!(containers[0].created_at, "2026-01-01 10:00:00 +0000 UTC");
        assert_eq!(containers[1].state, "exited");
    }

    #[test]
    fn a_malformed_line_is_skipped_not_fatal() {
        let output = format!(
            "{}\nnot json at all\n{{\"ID\": broken\n\n   \n{}\n",
            container_line("web", "running", ""),
            container_line("db", "exited", "")
        );
        let containers = parse_containers(&output);
        assert_eq!(containers.len(), 2);
        assert_eq!(containers[0].name, "web");
        assert_eq!(containers[1].name, "db");
    }

    #[test]
    fn missing_fields_fall_back_to_defaults() {
        // Only a name: everything else absent, as a stripped `--format` would
        // produce.
        let containers = parse_containers(r#"{"Names":"solo"}"#);
        assert_eq!(containers.len(), 1);
        assert_eq!(containers[0].name, "solo");
        assert_eq!(containers[0].id, "");
        assert_eq!(containers[0].image, "");
        assert_eq!(containers[0].status, "");
        assert_eq!(containers[0].project, None);
        // No State and no Status at all: not guessable.
        assert_eq!(containers[0].state, "unknown");
    }

    #[test]
    fn extra_fields_from_a_newer_docker_are_ignored() {
        let line = r#"{"ID":"x","Names":"web","State":"running","Networks":"bridge","Size":"0B","LocalVolumes":"2","RunningFor":"3 hours","Command":"nginx -g","Mounts":"/data","FutureColumn":{"nested":[1,2]}}"#;
        let containers = parse_containers(line);
        assert_eq!(containers.len(), 1);
        assert_eq!(containers[0].name, "web");
        assert_eq!(containers[0].state, "running");
    }

    #[test]
    fn only_the_first_of_several_names_is_kept() {
        let containers = parse_containers(r#"{"Names":"/web,/web_alias","State":"running"}"#);
        assert_eq!(containers[0].name, "web");
    }

    #[test]
    fn container_count_is_capped() {
        let output: String = (0..MAX_CONTAINERS + 25)
            .map(|index| format!("{}\n", container_line(&format!("c{index}"), "running", "")))
            .collect();
        assert_eq!(parse_containers(&output).len(), MAX_CONTAINERS);
    }

    // --- State normalisation -------------------------------------------------

    #[test]
    fn state_falls_back_to_the_status_text_on_older_docker() {
        assert_eq!(normalise_state("", "Up 3 hours"), "running");
        assert_eq!(normalise_state("", "Up 2 minutes (Paused)"), "paused");
        assert_eq!(normalise_state("", "Exited (0) 5 days ago"), "exited");
        assert_eq!(normalise_state("", "Created"), "created");
        assert_eq!(
            normalise_state("", "Restarting (1) 3 seconds ago"),
            "restarting"
        );
        assert_eq!(normalise_state("", "Removal In Progress"), "removing");
        assert_eq!(normalise_state("", "Dead"), "dead");
        assert_eq!(normalise_state("", "something else"), "unknown");
        // An explicit State column always wins, lowercased.
        assert_eq!(normalise_state("Running", "Exited (0)"), "running");
    }

    // --- Compose grouping ----------------------------------------------------

    #[test]
    fn compose_labels_are_extracted_from_the_flat_label_string() {
        let (project, service) = compose_labels(
            "com.docker.compose.project=shop,com.docker.compose.service=api,maintainer=nginx",
        );
        assert_eq!(project.as_deref(), Some("shop"));
        assert_eq!(service.as_deref(), Some("api"));

        // No compose labels at all, and label values that are present but empty.
        assert_eq!(compose_labels("maintainer=nginx"), (None, None));
        assert_eq!(compose_labels(""), (None, None));
        assert_eq!(compose_labels("com.docker.compose.project="), (None, None));
        // A value-less label must not panic the split.
        assert_eq!(compose_labels("standalone"), (None, None));
    }

    #[test]
    fn containers_group_by_compose_project_in_first_seen_order() {
        let output = format!(
            "{}\n{}\n{}\n",
            container_line("shop_api", "running", "com.docker.compose.project=shop"),
            container_line("blog_web", "running", "com.docker.compose.project=blog"),
            container_line("shop_db", "exited", "com.docker.compose.project=shop"),
        );
        let containers = parse_containers(&output);
        let projects = group_projects(&containers);
        assert_eq!(projects.len(), 2);
        assert_eq!(projects[0].name.as_deref(), Some("shop"));
        assert_eq!(projects[0].containers.len(), 2);
        assert_eq!(projects[0].containers[0].name, "shop_api");
        assert_eq!(projects[0].containers[1].name, "shop_db");
        assert_eq!(projects[1].name.as_deref(), Some("blog"));
        assert_eq!(projects[1].containers.len(), 1);
    }

    #[test]
    fn containers_without_compose_labels_land_in_a_trailing_ungrouped_bucket() {
        let output = format!(
            "{}\n{}\n{}\n",
            container_line("loose", "running", ""),
            container_line("shop_api", "running", "com.docker.compose.project=shop"),
            container_line("other", "exited", "maintainer=someone"),
        );
        let projects = group_projects(&parse_containers(&output));
        assert_eq!(projects.len(), 2);
        // The ungrouped bucket is last even though "loose" came first.
        assert_eq!(projects[0].name.as_deref(), Some("shop"));
        assert_eq!(projects[1].name, None);
        assert_eq!(projects[1].containers.len(), 2);
        assert_eq!(projects[1].containers[0].name, "loose");
        assert_eq!(projects[1].containers[1].name, "other");
    }

    #[test]
    fn an_all_compose_listing_has_no_ungrouped_bucket() {
        let output = container_line("shop_api", "running", "com.docker.compose.project=shop");
        let projects = group_projects(&parse_containers(&output));
        assert_eq!(projects.len(), 1);
        assert!(projects.iter().all(|project| project.name.is_some()));
    }

    #[test]
    fn no_containers_means_no_projects() {
        assert!(group_projects(&[]).is_empty());
        assert!(parse_containers("").is_empty());
    }

    // --- Availability classification ----------------------------------------

    #[test]
    fn a_missing_docker_binary_is_reported_as_not_installed() {
        assert_eq!(
            classify_unavailable(false, 127, "sh: docker: not found"),
            Some("docker not installed")
        );
        // Even a zero exit code cannot make an absent binary available.
        assert_eq!(
            classify_unavailable(false, 0, ""),
            Some("docker not installed")
        );
    }

    #[test]
    fn a_working_docker_has_no_reason() {
        assert_eq!(classify_unavailable(true, 0, ""), None);
        assert_eq!(classify_unavailable(true, 0, "{\"ID\":\"x\"}"), None);
    }

    #[test]
    fn a_user_outside_the_docker_group_is_reported_as_permission_denied() {
        // The real message mentions the daemon too, so this must beat the
        // daemon-down classification.
        let message = "Got permission denied while trying to connect to the Docker daemon \
                       socket at unix:///var/run/docker.sock: Get \
                       \"http://%2Fvar%2Frun%2Fdocker.sock/v1.24/containers/json\": dial unix \
                       /var/run/docker.sock: connect: permission denied";
        assert_eq!(
            classify_unavailable(true, 1, message),
            Some("permission denied")
        );
        assert_eq!(
            classify_unavailable(true, 1, "PERMISSION DENIED"),
            Some("permission denied")
        );
    }

    #[test]
    fn a_stopped_daemon_is_reported_as_not_running() {
        assert_eq!(
            classify_unavailable(
                true,
                1,
                "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. \
                 Is the docker daemon running?"
            ),
            Some("daemon not running")
        );
        assert_eq!(
            classify_unavailable(true, 1, "error during connect: this error may indicate…"),
            Some("daemon not running")
        );
    }

    #[test]
    fn an_unrecognised_failure_still_gets_a_reason() {
        assert_eq!(
            classify_unavailable(true, 1, "something entirely new went wrong"),
            Some("docker command failed")
        );
        // A non-zero exit with no output at all is still a failure.
        assert_eq!(
            classify_unavailable(true, 2, ""),
            Some("docker command failed")
        );
    }

    // --- Stats ---------------------------------------------------------------

    #[test]
    fn parses_stats_lines_and_percentages() {
        let output = "{\"ID\":\"abc123\",\"Name\":\"web\",\"CPUPerc\":\"12.34%\",\
                      \"MemUsage\":\"128.5MiB / 2GiB\",\"MemPerc\":\"6.27%\",\"NetIO\":\"1kB / 2kB\"}\n\
                      {\"ID\":\"def456\",\"Name\":\"/db\",\"CPUPerc\":\"--\",\
                      \"MemUsage\":\"0B / 0B\",\"MemPerc\":\"--\"}\n\
                      garbage\n";
        let stats = parse_stats(output);
        assert_eq!(stats.len(), 2);
        assert_eq!(stats[0].id, "abc123");
        assert_eq!(stats[0].name, "web");
        assert_eq!(stats[0].cpu_percent, Some(12.34));
        assert_eq!(stats[0].mem_usage, "128.5MiB / 2GiB");
        assert_eq!(stats[0].mem_percent, Some(6.27));
        // A stopped container reports "--" for both percentages.
        assert_eq!(stats[1].name, "db");
        assert_eq!(stats[1].cpu_percent, None);
        assert_eq!(stats[1].mem_percent, None);
    }

    #[test]
    fn percentages_tolerate_spacing_and_nonsense() {
        assert_eq!(parse_percent(" 0.00% "), Some(0.0));
        assert_eq!(parse_percent("100%"), Some(100.0));
        assert_eq!(parse_percent(""), None);
        assert_eq!(parse_percent("--"), None);
        assert_eq!(parse_percent("N/A"), None);
    }

    // --- Env redaction (security-relevant) -----------------------------------

    fn env(entries: &[&str]) -> Vec<EnvVar> {
        redact_env(&entries.iter().map(|e| e.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn secret_looking_keys_are_redacted() {
        let vars = env(&[
            "DB_PASSWORD=hunter2",
            "API_SECRET=s3cr3t",
            "GITHUB_TOKEN=ghp_abc",
            "SSH_PRIVATE_KEY=-----BEGIN",
            "AWS_CREDENTIALS=abc",
            "AUTH_HEADER=Bearer xyz",
        ]);
        assert_eq!(vars.len(), 6);
        for var in &vars {
            assert!(var.redacted, "{} should be redacted", var.key);
            assert_eq!(var.value, REDACTED);
        }
        // The key itself is never hidden — the user needs to know it is set.
        assert_eq!(vars[0].key, "DB_PASSWORD");
    }

    #[test]
    fn connection_strings_are_redacted_whatever_the_key_is_called() {
        // These key names match no marker, but the value carries a password.
        let vars = env(&[
            "DATABASE_URL=postgres://app:hunter2@db:5432/app",
            "SENTRY_DSN=https://abc:def@sentry.io/1",
            "AMQP=amqp://guest:guest@rabbit:5672/%2f",
        ]);
        for var in &vars {
            assert!(var.redacted, "{} should be redacted", var.key);
            assert_eq!(var.value, REDACTED);
        }
    }

    #[test]
    fn credential_free_urls_keep_their_values() {
        let vars = env(&[
            "API_URL=https://api.example.com/v1",
            "REDIS_URL=redis://cache:6379/0",
            // A bare "user@" with no password is not a credential.
            "REPO=ssh://git@github.com/acme/app.git",
        ]);
        for var in &vars {
            assert!(!var.redacted, "{} should not be redacted", var.key);
        }
    }

    #[test]
    fn ordinary_keys_keep_their_values() {
        let vars = env(&[
            "PATH=/usr/local/bin:/usr/bin",
            "NODE_ENV=production",
            "PORT=8080",
            "LANG=C.UTF-8",
            "HOME=/root",
        ]);
        for var in &vars {
            assert!(!var.redacted, "{} should not be redacted", var.key);
        }
        assert_eq!(vars[0].value, "/usr/local/bin:/usr/bin");
        assert_eq!(vars[1].value, "production");
        assert_eq!(vars[2].value, "8080");
    }

    #[test]
    fn redaction_is_case_insensitive() {
        for entry in [
            "password=x",
            "PASSWORD=x",
            "PassWord=x",
            "apiKey=x",
            "APIKEY=x",
            "Api_Token=x",
            "oAuth=x",
            "MY_Secret_Thing=x",
        ] {
            let vars = env(&[entry]);
            assert!(vars[0].redacted, "{entry} should be redacted");
            assert_eq!(vars[0].value, REDACTED);
        }
    }

    #[test]
    fn empty_values_are_left_empty_rather_than_faked() {
        // Nothing to hide, and "••••••" would claim a secret exists.
        let vars = env(&["DB_PASSWORD=", "EMPTY=", "BARE_NAME"]);
        assert_eq!(vars[0].key, "DB_PASSWORD");
        assert_eq!(vars[0].value, "");
        assert!(!vars[0].redacted);
        assert_eq!(vars[2].key, "BARE_NAME");
        assert_eq!(vars[2].value, "");
    }

    #[test]
    fn values_containing_equals_signs_are_split_only_once() {
        // No userinfo in this URL, so it survives intact — see
        // `connection_strings_are_redacted_whatever_the_key_is_called` for one
        // that does not.
        let vars = env(&["DATABASE_URL=postgres://h/db?a=b&c=d"]);
        assert_eq!(vars[0].key, "DATABASE_URL");
        assert_eq!(vars[0].value, "postgres://h/db?a=b&c=d");
        // …and a secret key keeps the whole tail hidden.
        let vars = env(&["JWT_SECRET=a=b=c"]);
        assert!(vars[0].redacted);
        assert_eq!(vars[0].value, REDACTED);
    }

    #[test]
    fn redaction_leaves_no_trace_of_the_original_value() {
        let secret = "correct-horse-battery-staple";
        let vars = env(&[&format!("APP_SECRET={secret}")]);
        let json = serde_json::to_string(&vars).unwrap();
        assert!(!json.contains(secret), "{json}");
        assert!(json.contains(REDACTED));
    }

    // --- Inspect -------------------------------------------------------------

    const INSPECT: &str = r#"[
      {
        "Name": "/shop_api_1",
        "RestartCount": 3,
        "Config": {
          "Image": "shop/api:2.1",
          "Env": ["PATH=/usr/bin", "DB_PASSWORD=hunter2", "NODE_ENV=production"],
          "Cmd": ["node", "server.js"]
        },
        "State": { "Status": "running", "StartedAt": "2026-07-01T09:00:00Z", "ExitCode": 0 },
        "HostConfig": { "RestartPolicy": { "Name": "unless-stopped", "MaximumRetryCount": 0 } },
        "Mounts": [
          { "Type": "bind", "Source": "/srv/data", "Destination": "/data", "RW": true },
          { "Type": "volume", "Name": "pgdata", "Source": "", "Destination": "/var/lib/pg", "RW": false }
        ],
        "NetworkSettings": {
          "Ports": {
            "80/tcp": [{ "HostIp": "0.0.0.0", "HostPort": "8080" }],
            "9000/tcp": null
          },
          "Networks": { "bridge": {}, "shop_default": {} }
        }
      }
    ]"#;

    #[test]
    fn inspect_extracts_the_fields_the_dialog_shows() {
        let inspect = parse_inspect(INSPECT).expect("valid inspect payload");
        assert_eq!(inspect.name, "shop_api_1");
        assert_eq!(inspect.image, "shop/api:2.1");
        assert_eq!(inspect.state, "running");
        assert_eq!(inspect.started_at.as_deref(), Some("2026-07-01T09:00:00Z"));
        assert_eq!(inspect.restart_count, 3);
        assert_eq!(inspect.restart_policy.as_deref(), Some("unless-stopped"));
        assert_eq!(inspect.command.as_deref(), Some("node server.js"));
        assert_eq!(inspect.networks, vec!["bridge", "shop_default"]);
    }

    #[test]
    fn inspect_redacts_env_before_it_leaves_rust() {
        let inspect = parse_inspect(INSPECT).unwrap();
        let password = inspect
            .env
            .iter()
            .find(|var| var.key == "DB_PASSWORD")
            .unwrap();
        assert!(password.redacted);
        assert_eq!(password.value, REDACTED);
        assert!(!serde_json::to_string(&inspect).unwrap().contains("hunter2"));
        let node_env = inspect
            .env
            .iter()
            .find(|var| var.key == "NODE_ENV")
            .unwrap();
        assert_eq!(node_env.value, "production");
    }

    #[test]
    fn inspect_names_volumes_that_have_no_host_path() {
        let inspect = parse_inspect(INSPECT).unwrap();
        assert_eq!(
            inspect.mounts,
            vec![
                DockerMount {
                    kind: "bind".into(),
                    source: "/srv/data".into(),
                    destination: "/data".into(),
                    rw: true,
                },
                DockerMount {
                    kind: "volume".into(),
                    // Falls back to the volume NAME when Source is blank.
                    source: "pgdata".into(),
                    destination: "/var/lib/pg".into(),
                    rw: false,
                },
            ]
        );
    }

    #[test]
    fn inspect_renders_published_and_unpublished_ports() {
        let inspect = parse_inspect(INSPECT).unwrap();
        assert_eq!(
            inspect.ports,
            vec![
                PortBinding {
                    container: "80/tcp".into(),
                    host: "0.0.0.0:8080".into(),
                },
                PortBinding {
                    // Exposed but never published: no host side.
                    container: "9000/tcp".into(),
                    host: String::new(),
                },
            ]
        );
    }

    #[test]
    fn inspect_tolerates_a_sparse_payload() {
        let inspect = parse_inspect(r#"[{"Name":"/bare"}]"#).expect("sparse but valid");
        assert_eq!(inspect.name, "bare");
        assert_eq!(inspect.image, "");
        assert_eq!(inspect.started_at, None);
        assert_eq!(inspect.restart_policy, None);
        assert_eq!(inspect.command, None);
        assert!(inspect.env.is_empty());
        assert!(inspect.mounts.is_empty());
        assert!(inspect.ports.is_empty());
    }

    #[test]
    fn inspect_rejects_output_that_is_not_the_expected_array() {
        // docker's own error text, an empty array for a missing container, and
        // a bare object all have to come back as None rather than panicking.
        assert!(parse_inspect("Error: No such object: nope").is_none());
        assert!(parse_inspect("[]").is_none());
        assert!(parse_inspect("{}").is_none());
        assert!(parse_inspect("").is_none());
    }
}
