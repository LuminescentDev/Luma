use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};

use crate::errors::{LumaError, Result};
use crate::storage::hosts::{self, Host, HostInput};
use crate::terminal::home_dir;

const MAX_IMPORT_ENTRIES: usize = 500;
const MAX_PROXY_DEPTH: usize = 8;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigCandidate {
    pub name: String,
    pub hostname: String,
    pub port: u16,
    pub username: Option<String>,
    pub identity_file: Option<String>,
    pub proxy_jump: Option<String>,
    pub already_exists: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigImportRequest {
    pub selected_names: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigImportResult {
    pub imported_hosts: Vec<Host>,
    pub skipped_existing: Vec<String>,
}

#[derive(Debug, Clone, Default)]
struct HostBlock {
    aliases: Vec<String>,
    hostname: Option<String>,
    port: Option<u16>,
    username: Option<String>,
    identity_file: Option<String>,
    proxy_jump: Option<String>,
}

fn strip_comment(line: &str) -> String {
    let mut result = String::new();
    let mut quote = None;
    let mut escaped = false;
    for character in line.chars() {
        if escaped {
            result.push(character);
            escaped = false;
            continue;
        }
        if character == '\\' {
            escaped = true;
            result.push(character);
            continue;
        }
        if matches!(character, '\'' | '"') {
            if quote == Some(character) {
                quote = None;
            } else if quote.is_none() {
                quote = Some(character);
            }
            result.push(character);
            continue;
        }
        if character == '#' && quote.is_none() {
            break;
        }
        result.push(character);
    }
    result
}

fn split_words(value: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    let mut characters = value.chars().peekable();
    while let Some(character) = characters.next() {
        if character == '\\' && quote != Some('\'') {
            match characters.peek().copied() {
                Some(next) if next.is_whitespace() || matches!(next, '\\' | '\'' | '"') => {
                    current.push(characters.next().unwrap());
                }
                _ => current.push(character),
            }
            continue;
        }
        if matches!(character, '\'' | '"') {
            if quote == Some(character) {
                quote = None;
            } else if quote.is_none() {
                quote = Some(character);
            } else {
                current.push(character);
            }
            continue;
        }
        if character.is_whitespace() && quote.is_none() {
            if !current.is_empty() {
                words.push(std::mem::take(&mut current));
            }
        } else {
            current.push(character);
        }
    }
    if !current.is_empty() {
        words.push(current);
    }
    words
}

fn directive(line: &str) -> Option<(String, String)> {
    let line = strip_comment(line);
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let split_at = line.char_indices().find_map(|(index, character)| {
        (character.is_whitespace() || character == '=').then_some(index)
    })?;
    let key = line[..split_at].trim().to_ascii_lowercase();
    let value = line[split_at..]
        .trim_start_matches(|character: char| character.is_whitespace() || character == '=')
        .trim()
        .to_string();
    (!key.is_empty() && !value.is_empty()).then_some((key, value))
}

fn concrete_aliases(value: &str) -> Vec<String> {
    split_words(value)
        .into_iter()
        .filter(|pattern| {
            !pattern.starts_with('!')
                && !pattern.contains('*')
                && !pattern.contains('?')
                && !pattern.contains('[')
        })
        .collect()
}

fn flush_block(block: &mut Option<HostBlock>, candidates: &mut Vec<SshConfigCandidate>) {
    let Some(block) = block.take() else {
        return;
    };
    for alias in block.aliases {
        let hostname = block
            .hostname
            .as_deref()
            .filter(|hostname| *hostname != "%h")
            .unwrap_or(&alias)
            .to_string();
        candidates.push(SshConfigCandidate {
            name: alias,
            hostname,
            port: block.port.unwrap_or(22),
            username: block.username.clone(),
            identity_file: block.identity_file.clone(),
            proxy_jump: block.proxy_jump.clone(),
            already_exists: false,
        });
    }
}

pub fn parse_config(contents: &str) -> Vec<SshConfigCandidate> {
    let mut candidates = Vec::new();
    let mut block: Option<HostBlock> = None;

    for line in contents.lines() {
        let Some((key, value)) = directive(line) else {
            continue;
        };
        if key == "host" {
            flush_block(&mut block, &mut candidates);
            let aliases = concrete_aliases(&value);
            block = (!aliases.is_empty()).then_some(HostBlock {
                aliases,
                ..HostBlock::default()
            });
            continue;
        }
        let Some(block) = block.as_mut() else {
            continue;
        };
        match key.as_str() {
            "hostname" if block.hostname.is_none() => {
                block.hostname = split_words(&value).into_iter().next();
            }
            "port" if block.port.is_none() => {
                block.port = value.parse::<u16>().ok().filter(|port| *port > 0);
            }
            "user" if block.username.is_none() => {
                block.username = split_words(&value).into_iter().next();
            }
            "identityfile" if block.identity_file.is_none() => {
                block.identity_file = split_words(&value).into_iter().next();
            }
            "proxyjump" if block.proxy_jump.is_none() => {
                block.proxy_jump = split_words(&value).into_iter().next();
            }
            _ => {}
        }
    }
    flush_block(&mut block, &mut candidates);

    let mut seen = HashSet::new();
    candidates.retain(|candidate| seen.insert(candidate.name.to_ascii_lowercase()));
    candidates
}

fn config_path() -> Option<PathBuf> {
    home_dir().map(|home| home.join(".ssh").join("config"))
}

fn read_config() -> Result<String> {
    let Some(path) = config_path() else {
        return Ok(String::new());
    };
    match std::fs::read_to_string(path) {
        Ok(contents) => Ok(contents),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(LumaError::Io(error)),
    }
}

pub async fn preview_config(pool: &SqlitePool) -> Result<Vec<SshConfigCandidate>> {
    let mut candidates = parse_config(&read_config()?);
    let rows = sqlx::query("SELECT name FROM hosts")
        .fetch_all(pool)
        .await?;
    let existing: HashSet<String> = rows
        .iter()
        .map(|row| row.get::<String, _>("name").to_ascii_lowercase())
        .collect();
    for candidate in &mut candidates {
        candidate.already_exists = existing.contains(&candidate.name.to_ascii_lowercase());
    }
    Ok(candidates)
}

fn expanded_identity_file(path: &str) -> String {
    let Some(home) = home_dir() else {
        return path.to_string();
    };
    let home_text = home.to_string_lossy();
    if path == "~" {
        return home_text.into_owned();
    }
    if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        return home.join(rest).to_string_lossy().into_owned();
    }
    path.replace("%d", &home_text)
}

fn proxy_alias(proxy_jump: &str) -> Option<String> {
    let target = proxy_jump.split(',').next_back()?.trim();
    if target.is_empty() || target.eq_ignore_ascii_case("none") {
        return None;
    }
    let target = target.rsplit_once('@').map_or(target, |(_, host)| host);
    if let Some(stripped) = target.strip_prefix('[') {
        return stripped.split_once(']').map(|(host, _)| host.to_string());
    }
    if let Some((host, port)) = target.rsplit_once(':') {
        if port.parse::<u16>().is_ok() {
            return Some(host.to_string());
        }
    }
    Some(target.to_string())
}

fn validate_proxy_graph(graph: &HashMap<String, Option<String>>, start_id: &str) -> Result<()> {
    let mut seen = HashSet::new();
    let mut next = Some(start_id.to_string());
    let mut depth = 0;
    while let Some(id) = next {
        if !seen.insert(id.clone()) {
            return Err(LumaError::InvalidInput(
                "imported ProxyJump relationships create a cycle".into(),
            ));
        }
        next = graph.get(&id).cloned().flatten();
        if next.is_some() {
            depth += 1;
            if depth > MAX_PROXY_DEPTH {
                return Err(LumaError::InvalidInput(format!(
                    "imported ProxyJump chain may contain at most {MAX_PROXY_DEPTH} hosts"
                )));
            }
        }
    }
    Ok(())
}

pub async fn import_config(
    pool: &SqlitePool,
    request: SshConfigImportRequest,
) -> Result<SshConfigImportResult> {
    if request.selected_names.len() > MAX_IMPORT_ENTRIES {
        return Err(LumaError::InvalidInput(format!(
            "at most {MAX_IMPORT_ENTRIES} SSH config entries can be imported at once"
        )));
    }
    let selected: HashSet<String> = request
        .selected_names
        .iter()
        .map(|name| name.to_ascii_lowercase())
        .collect();
    if selected.len() != request.selected_names.len() {
        return Err(LumaError::InvalidInput(
            "selectedNames contains duplicate entries".into(),
        ));
    }

    let parsed = parse_config(&read_config()?);
    let available: HashSet<String> = parsed
        .iter()
        .map(|candidate| candidate.name.to_ascii_lowercase())
        .collect();
    if let Some(unknown) = selected.iter().find(|name| !available.contains(*name)) {
        return Err(LumaError::InvalidInput(format!(
            "SSH config entry was not found: {unknown}"
        )));
    }

    let existing_rows = sqlx::query("SELECT id, name, proxy_jump_host_id FROM hosts")
        .fetch_all(pool)
        .await?;
    let mut host_ids_by_name = HashMap::new();
    let mut proxy_graph = HashMap::new();
    for row in &existing_rows {
        let id: String = row.get("id");
        let name: String = row.get("name");
        let proxy_id: Option<String> = row.get("proxy_jump_host_id");
        host_ids_by_name.insert(name.to_ascii_lowercase(), id.clone());
        proxy_graph.insert(id, proxy_id);
    }

    let mut skipped_existing = Vec::new();
    let mut imports = Vec::new();
    for candidate in parsed {
        if !selected.contains(&candidate.name.to_ascii_lowercase()) {
            continue;
        }
        match host_ids_by_name.entry(candidate.name.to_ascii_lowercase()) {
            std::collections::hash_map::Entry::Occupied(_) => {
                skipped_existing.push(candidate.name);
            }
            std::collections::hash_map::Entry::Vacant(entry) => {
                let id = uuid::Uuid::new_v4().to_string();
                entry.insert(id.clone());
                imports.push((id, candidate));
            }
        }
    }

    let mut prepared = Vec::with_capacity(imports.len());
    for (id, candidate) in imports {
        let proxy_id = candidate
            .proxy_jump
            .as_deref()
            .and_then(proxy_alias)
            .and_then(|name| host_ids_by_name.get(&name.to_ascii_lowercase()).cloned());
        let key_id = candidate
            .identity_file
            .as_ref()
            .map(|_| uuid::Uuid::new_v4().to_string());
        let input = HostInput {
            name: candidate.name.clone(),
            hostname: candidate.hostname.clone(),
            port: i64::from(candidate.port),
            username: candidate.username.clone(),
            group_id: None,
            authentication_type: if key_id.is_some() {
                "key".into()
            } else {
                "agent".into()
            },
            key_id: key_id.clone(),
            identity_id: None,
            proxy_jump_host_id: proxy_id.clone(),
            startup_command: None,
            working_directory: None,
            environment: None,
            tags: Vec::new(),
            favorite: false,
            tab_color: None,
        };
        hosts::validate_fields(&input)?;
        proxy_graph.insert(id.clone(), proxy_id);
        prepared.push((id, candidate, input, key_id));
    }
    for (id, _, _, _) in &prepared {
        validate_proxy_graph(&proxy_graph, id)?;
    }

    let mut transaction = pool.begin().await?;
    for (host_id, candidate, input, generated_key_id) in &prepared {
        let key_id = if let Some(identity_file) = &candidate.identity_file {
            let local_path = expanded_identity_file(identity_file);
            if let Some(existing_key_id) = sqlx::query_scalar::<_, String>(
                "SELECT id FROM key_references
                 WHERE storage_mode = 'local-path' AND local_path = ?1 LIMIT 1",
            )
            .bind(&local_path)
            .fetch_optional(&mut *transaction)
            .await?
            {
                Some(existing_key_id)
            } else {
                let key_id = generated_key_id
                    .clone()
                    .expect("identity file imports always prepare a key id");
                let mut key_name = format!("{} key", candidate.name);
                key_name.truncate(key_name.floor_char_boundary(128));
                sqlx::query(
                    "INSERT INTO key_references (id, name, storage_mode, local_path)
                     VALUES (?1, ?2, 'local-path', ?3)",
                )
                .bind(&key_id)
                .bind(key_name)
                .bind(local_path)
                .execute(&mut *transaction)
                .await?;
                Some(key_id)
            }
        } else {
            None
        };

        sqlx::query(
            "INSERT INTO hosts (
                 id, name, hostname, port, username, auth_type, key_id, tags, favorite
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, '[]', 0)",
        )
        .bind(host_id)
        .bind(input.name.trim())
        .bind(input.hostname.trim())
        .bind(input.port)
        .bind(input.username.as_deref().map(str::trim))
        .bind(&input.authentication_type)
        .bind(key_id)
        .execute(&mut *transaction)
        .await?;
    }
    for (host_id, _, input, _) in &prepared {
        if input.proxy_jump_host_id.is_some() {
            sqlx::query("UPDATE hosts SET proxy_jump_host_id = ?2 WHERE id = ?1")
                .bind(host_id)
                .bind(&input.proxy_jump_host_id)
                .execute(&mut *transaction)
                .await?;
        }
    }
    transaction.commit().await?;

    let mut imported_hosts = Vec::with_capacity(prepared.len());
    for (id, _, _, _) in prepared {
        if let Some(host) = hosts::get(pool, &id).await? {
            imported_hosts.push(host);
        }
    }
    Ok(SshConfigImportResult {
        imported_hosts,
        skipped_existing,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ssh_config_fixture_without_wildcards() {
        let fixture = r#"
# Global option is ignored.
ServerAliveInterval 30

Host *
  User default-user

Host bastion
  HostName bastion.example.com
  Port 2222
  User jump
  IdentityFile "~/.ssh/jump key"

Host app app-alias *.internal !excluded
  HostName app.internal
  User deploy
  IdentityFile ~/.ssh/id_ed25519
  ProxyJump jump@bastion:2222

Host equals-style
  HostName=equals.example.com
  Port=2200
"#;
        let candidates = parse_config(fixture);
        assert_eq!(candidates.len(), 4);
        assert_eq!(candidates[0].name, "bastion");
        assert_eq!(candidates[0].port, 2222);
        assert_eq!(
            candidates[0].identity_file.as_deref(),
            Some("~/.ssh/jump key")
        );
        assert_eq!(candidates[1].name, "app");
        assert_eq!(candidates[2].name, "app-alias");
        assert_eq!(
            candidates[1].proxy_jump.as_deref(),
            Some("jump@bastion:2222")
        );
        assert_eq!(candidates[3].hostname, "equals.example.com");
        assert_eq!(candidates[3].port, 2200);
        assert!(!candidates.iter().any(|candidate| candidate.name == "*"));
    }

    #[test]
    fn preserves_windows_paths_and_supports_escaped_spaces() {
        assert_eq!(
            split_words(r"C:\Users\Alice\.ssh\id_ed25519"),
            vec![r"C:\Users\Alice\.ssh\id_ed25519"]
        );
        assert_eq!(
            split_words(r"~/.ssh/key\ with\ spaces"),
            vec!["~/.ssh/key with spaces"]
        );
    }

    #[test]
    fn extracts_proxy_aliases() {
        assert_eq!(proxy_alias("bastion").as_deref(), Some("bastion"));
        assert_eq!(
            proxy_alias("first,jump@bastion:2222").as_deref(),
            Some("bastion")
        );
        assert_eq!(proxy_alias("none"), None);
    }
}
