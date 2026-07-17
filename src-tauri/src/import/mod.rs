use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;

use serde::de::{IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use sqlx::{Row, SqlitePool};

use crate::errors::{LumaError, Result};
use crate::storage::host_groups;
use crate::storage::hosts::{self, Host, HostInput};
use crate::storage::key_references::{self, KeyReferenceInput};
use crate::terminal::home_dir;

const MAX_IMPORT_ENTRIES: usize = 500;
const MAX_IMPORT_FILE_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportedHostCandidate {
    pub name: String,
    pub hostname: String,
    pub port: u16,
    pub username: Option<String>,
    pub group: Option<String>,
    pub auth_hint: String,
    pub already_exists: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportHostsRequest {
    pub selected_names: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedHostsResult {
    pub imported_hosts: Vec<Host>,
    pub created_groups: Vec<String>,
    pub skipped_existing: Vec<String>,
}

#[derive(Debug, Clone, Copy)]
enum ImportSource {
    Tabby,
    Electerm,
}

impl ImportSource {
    fn parse(value: &str) -> Result<Self> {
        match value {
            "tabby" => Ok(Self::Tabby),
            "electerm" => Ok(Self::Electerm),
            _ => Err(LumaError::InvalidInput(
                "source must be exactly 'tabby' or 'electerm'".into(),
            )),
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Tabby => "Tabby",
            Self::Electerm => "Electerm",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedCandidate {
    name: String,
    hostname: String,
    port: u16,
    username: Option<String>,
    group: Option<String>,
    auth_hint: String,
    identity_file: Option<String>,
}

impl ParsedCandidate {
    fn public(&self, already_exists: bool) -> ImportedHostCandidate {
        ImportedHostCandidate {
            name: self.name.clone(),
            hostname: self.hostname.clone(),
            port: self.port,
            username: self.username.clone(),
            group: self.group.clone(),
            auth_hint: self.auth_hint.clone(),
            already_exists,
        }
    }
}

#[derive(Debug, Default)]
struct LooseString(Option<String>);

impl<'de> Deserialize<'de> for LooseString {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct LooseStringVisitor;

        impl<'de> Visitor<'de> for LooseStringVisitor {
            type Value = LooseString;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a string-like value")
            }

            fn visit_str<E>(self, value: &str) -> std::result::Result<Self::Value, E> {
                Ok(LooseString(Some(value.to_string())))
            }

            fn visit_string<E>(self, value: String) -> std::result::Result<Self::Value, E> {
                Ok(LooseString(Some(value)))
            }

            fn visit_i64<E>(self, value: i64) -> std::result::Result<Self::Value, E> {
                Ok(LooseString(Some(value.to_string())))
            }

            fn visit_u64<E>(self, value: u64) -> std::result::Result<Self::Value, E> {
                Ok(LooseString(Some(value.to_string())))
            }

            fn visit_f64<E>(self, value: f64) -> std::result::Result<Self::Value, E> {
                let value =
                    (value.is_finite() && value.fract() == 0.0).then(|| format!("{value:.0}"));
                Ok(LooseString(value))
            }

            fn visit_bool<E>(self, _value: bool) -> std::result::Result<Self::Value, E> {
                Ok(LooseString(None))
            }

            fn visit_none<E>(self) -> std::result::Result<Self::Value, E> {
                Ok(LooseString(None))
            }

            fn visit_unit<E>(self) -> std::result::Result<Self::Value, E> {
                Ok(LooseString(None))
            }

            fn visit_seq<A>(self, mut sequence: A) -> std::result::Result<Self::Value, A::Error>
            where
                A: SeqAccess<'de>,
            {
                while sequence.next_element::<IgnoredAny>()?.is_some() {}
                Ok(LooseString(None))
            }

            fn visit_map<A>(self, mut map: A) -> std::result::Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                let mut result = None;
                while let Some(key) = map.next_key::<LooseString>()? {
                    let key = key.0.unwrap_or_default();
                    if matches!(
                        key.as_str(),
                        "type"
                            | "method"
                            | "authType"
                            | "id"
                            | "path"
                            | "file"
                            | "filename"
                            | "localPath"
                            | "privateKeyPath"
                            | "identityFile"
                    ) {
                        let value = map.next_value::<LooseString>()?.0;
                        if result.is_none() {
                            result = value;
                        }
                    } else {
                        map.next_value::<IgnoredAny>()?;
                    }
                }
                Ok(LooseString(result))
            }
        }

        deserializer.deserialize_any(LooseStringVisitor)
    }
}

fn deserialize_loose_string<'de, D>(
    deserializer: D,
) -> std::result::Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    LooseString::deserialize(deserializer).map(|value| value.0)
}

fn deserialize_loose_strings<'de, D>(deserializer: D) -> std::result::Result<Vec<String>, D::Error>
where
    D: Deserializer<'de>,
{
    struct LooseStringsVisitor;

    impl<'de> Visitor<'de> for LooseStringsVisitor {
        type Value = Vec<String>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("a string or list of string-like values")
        }

        fn visit_str<E>(self, value: &str) -> std::result::Result<Self::Value, E> {
            Ok(vec![value.to_string()])
        }

        fn visit_string<E>(self, value: String) -> std::result::Result<Self::Value, E> {
            Ok(vec![value])
        }

        fn visit_seq<A>(self, mut sequence: A) -> std::result::Result<Self::Value, A::Error>
        where
            A: SeqAccess<'de>,
        {
            let mut values = Vec::new();
            while let Some(value) = sequence.next_element::<LooseString>()? {
                if let Some(value) = value.0 {
                    values.push(value);
                }
            }
            Ok(values)
        }

        fn visit_map<A>(self, mut map: A) -> std::result::Result<Self::Value, A::Error>
        where
            A: MapAccess<'de>,
        {
            let mut values = Vec::new();
            while let Some(key) = map.next_key::<LooseString>()? {
                let key = key.0.unwrap_or_default();
                if matches!(
                    key.as_str(),
                    "path" | "file" | "filename" | "localPath" | "privateKeyPath" | "identityFile"
                ) {
                    if let Some(value) = map.next_value::<LooseString>()?.0 {
                        values.push(value);
                    }
                } else {
                    map.next_value::<IgnoredAny>()?;
                }
            }
            Ok(values)
        }

        fn visit_none<E>(self) -> std::result::Result<Self::Value, E> {
            Ok(Vec::new())
        }

        fn visit_unit<E>(self) -> std::result::Result<Self::Value, E> {
            Ok(Vec::new())
        }
    }

    deserializer.deserialize_any(LooseStringsVisitor)
}

fn deserialize_port<'de, D>(deserializer: D) -> std::result::Result<Option<u16>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = LooseString::deserialize(deserializer)?.0;
    Ok(value
        .as_deref()
        .and_then(|value| value.trim().parse::<u16>().ok())
        .filter(|port| *port > 0))
}

#[derive(Debug, Default, Deserialize)]
struct TabbyConfig {
    #[serde(default)]
    profiles: Vec<TabbyProfile>,
    #[serde(default)]
    groups: Vec<TabbyGroup>,
}

#[derive(Debug, Default, Deserialize)]
struct TabbyProfile {
    #[serde(
        rename = "type",
        default,
        deserialize_with = "deserialize_loose_string"
    )]
    profile_type: Option<String>,
    #[serde(default, deserialize_with = "deserialize_loose_string")]
    name: Option<String>,
    #[serde(default, deserialize_with = "deserialize_loose_string")]
    group: Option<String>,
    #[serde(
        rename = "groupId",
        default,
        deserialize_with = "deserialize_loose_string"
    )]
    group_id: Option<String>,
    #[serde(default)]
    options: TabbyOptions,
}

#[derive(Debug, Default, Deserialize)]
struct TabbyOptions {
    #[serde(default, deserialize_with = "deserialize_loose_string")]
    host: Option<String>,
    #[serde(default, deserialize_with = "deserialize_port")]
    port: Option<u16>,
    #[serde(default, deserialize_with = "deserialize_loose_string")]
    user: Option<String>,
    #[serde(default, deserialize_with = "deserialize_loose_string")]
    auth: Option<String>,
    #[serde(default, deserialize_with = "deserialize_loose_string")]
    group: Option<String>,
    #[serde(
        rename = "groupId",
        default,
        deserialize_with = "deserialize_loose_string"
    )]
    group_id: Option<String>,
    #[serde(
        rename = "identityFile",
        default,
        deserialize_with = "deserialize_loose_string"
    )]
    identity_file: Option<String>,
    #[serde(
        rename = "privateKeyPath",
        default,
        deserialize_with = "deserialize_loose_string"
    )]
    private_key_path: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct TabbyGroup {
    #[serde(default, deserialize_with = "deserialize_loose_string")]
    id: Option<String>,
    #[serde(default, deserialize_with = "deserialize_loose_string")]
    name: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct ElectermObject {
    #[serde(default)]
    bookmarks: Vec<ElectermBookmark>,
    #[serde(default, rename = "bookmarkGroups", alias = "bookmark_groups")]
    bookmark_groups: Vec<ElectermGroup>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum ElectermExport {
    Object(ElectermObject),
    Array(Vec<ElectermBookmark>),
}

#[derive(Debug, Default, Deserialize)]
struct ElectermBookmark {
    #[serde(default, deserialize_with = "deserialize_loose_string")]
    id: Option<String>,
    #[serde(rename = "_id", default, deserialize_with = "deserialize_loose_string")]
    alternate_id: Option<String>,
    #[serde(default, deserialize_with = "deserialize_loose_string")]
    title: Option<String>,
    #[serde(default, deserialize_with = "deserialize_loose_string")]
    name: Option<String>,
    #[serde(default, deserialize_with = "deserialize_loose_string")]
    host: Option<String>,
    #[serde(default, deserialize_with = "deserialize_port")]
    port: Option<u16>,
    #[serde(default, deserialize_with = "deserialize_loose_string")]
    username: Option<String>,
    #[serde(
        rename = "authType",
        default,
        deserialize_with = "deserialize_loose_string"
    )]
    auth_type: Option<String>,
    #[serde(
        rename = "type",
        default,
        deserialize_with = "deserialize_loose_string"
    )]
    bookmark_type: Option<String>,
    #[serde(default, deserialize_with = "deserialize_loose_string")]
    category: Option<String>,
    #[serde(
        rename = "categoryId",
        default,
        deserialize_with = "deserialize_loose_string"
    )]
    category_id: Option<String>,
    #[serde(
        rename = "identityFile",
        default,
        deserialize_with = "deserialize_loose_string"
    )]
    identity_file: Option<String>,
    #[serde(
        rename = "privateKeyPath",
        default,
        deserialize_with = "deserialize_loose_string"
    )]
    private_key_path: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct ElectermGroup {
    #[serde(default, deserialize_with = "deserialize_loose_string")]
    id: Option<String>,
    #[serde(rename = "_id", default, deserialize_with = "deserialize_loose_string")]
    alternate_id: Option<String>,
    #[serde(default, deserialize_with = "deserialize_loose_string")]
    title: Option<String>,
    #[serde(default, deserialize_with = "deserialize_loose_string")]
    name: Option<String>,
    #[serde(
        rename = "bookmarkIds",
        alias = "bookmark_ids",
        default,
        deserialize_with = "deserialize_loose_strings"
    )]
    bookmark_ids: Vec<String>,
}

fn trimmed(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim();
        (!value.is_empty()).then(|| value.to_string())
    })
}

fn first_trimmed(values: impl IntoIterator<Item = Option<String>>) -> Option<String> {
    values.into_iter().find_map(trimmed)
}

fn auth_hint(value: Option<&str>, has_identity_file: bool) -> String {
    let normalized = value
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .replace(['_', ' '], "-");
    let hint = match normalized.as_str() {
        "password" | "pass" => "password",
        "keyboard-interactive" | "keyboardinteractive" | "interactive" => "keyboard-interactive",
        "public-key" | "publickey" | "private-key" | "privatekey" | "key" => "public-key",
        "agent" | "ssh-agent" | "sshagent" => "agent",
        _ if has_identity_file => "public-key",
        _ => "unknown",
    };
    hint.to_string()
}

fn concrete_identity_path(value: Option<String>) -> Option<String> {
    let value = trimmed(value)?;
    if value.len() > 4096 || value.contains(['\0', '\n', '\r']) {
        return None;
    }
    let uppercase = value.to_ascii_uppercase();
    if uppercase.contains("PRIVATE KEY") || value.starts_with("ssh-") {
        return None;
    }
    let bytes = value.as_bytes();
    let looks_like_path = value.starts_with(['~', '/', '\\', '.'])
        || value.contains(['/', '\\'])
        || bytes.get(1) == Some(&b':')
        || [".pem", ".ppk", ".key"]
            .iter()
            .any(|extension| value.to_ascii_lowercase().ends_with(extension));
    looks_like_path.then_some(value)
}

fn push_candidate(
    candidates: &mut Vec<ParsedCandidate>,
    seen: &mut HashSet<String>,
    candidate: ParsedCandidate,
) {
    if candidates.len() < MAX_IMPORT_ENTRIES && seen.insert(candidate.name.to_ascii_lowercase()) {
        candidates.push(candidate);
    }
}

fn parse_tabby(contents: &str) -> Result<Vec<ParsedCandidate>> {
    let config: TabbyConfig = serde_yml::from_str(contents).map_err(|_| {
        LumaError::InvalidInput("could not parse Tabby config: invalid YAML".into())
    })?;
    let group_names: HashMap<String, String> = config
        .groups
        .into_iter()
        .filter_map(|group| Some((trimmed(group.id)?, trimmed(group.name)?)))
        .collect();

    let mut candidates = Vec::new();
    let mut seen = HashSet::new();
    for profile in config.profiles {
        if profile
            .profile_type
            .as_deref()
            .is_none_or(|value| !value.trim().eq_ignore_ascii_case("ssh"))
        {
            continue;
        }
        let Some(hostname) = trimmed(profile.options.host) else {
            continue;
        };
        let name = trimmed(profile.name).unwrap_or_else(|| hostname.clone());
        let group_id = first_trimmed([
            profile.group_id,
            profile.group,
            profile.options.group_id,
            profile.options.group,
        ]);
        let group = group_id.and_then(|id| group_names.get(&id).cloned());
        let identity_file = [
            profile.options.identity_file,
            profile.options.private_key_path,
        ]
        .into_iter()
        .find_map(concrete_identity_path);
        let hint = auth_hint(profile.options.auth.as_deref(), identity_file.is_some());
        push_candidate(
            &mut candidates,
            &mut seen,
            ParsedCandidate {
                name,
                hostname,
                port: profile.options.port.unwrap_or(22),
                username: trimmed(profile.options.user),
                group,
                auth_hint: hint,
                identity_file,
            },
        );
    }
    Ok(candidates)
}

fn electerm_is_ssh(bookmark_type: Option<&str>) -> bool {
    let normalized = bookmark_type
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if normalized == "ssh" {
        return true;
    }
    !matches!(
        normalized.as_str(),
        "serial" | "telnet" | "local" | "shell" | "terminal" | "sftp" | "rdp" | "vnc"
    )
}

fn parse_electerm(contents: &str) -> Result<Vec<ParsedCandidate>> {
    let export: ElectermExport = serde_json::from_str(contents).map_err(|error| {
        LumaError::InvalidInput(format!(
            "could not parse Electerm config: invalid JSON near line {}, column {}",
            error.line(),
            error.column()
        ))
    })?;
    let (bookmarks, groups) = match export {
        ElectermExport::Object(object) => (object.bookmarks, object.bookmark_groups),
        ElectermExport::Array(bookmarks) => (bookmarks, Vec::new()),
    };

    let mut group_names = HashMap::new();
    let mut bookmark_groups = HashMap::new();
    for group in groups {
        let group_id = first_trimmed([group.id, group.alternate_id]);
        let group_name = first_trimmed([group.title, group.name]);
        let (Some(group_id), Some(group_name)) = (group_id, group_name) else {
            continue;
        };
        group_names.insert(group_id.clone(), group_name.clone());
        for bookmark_id in group
            .bookmark_ids
            .into_iter()
            .filter_map(|id| trimmed(Some(id)))
        {
            bookmark_groups
                .entry(bookmark_id)
                .or_insert_with(|| group_name.clone());
        }
    }

    let mut candidates = Vec::new();
    let mut seen = HashSet::new();
    for bookmark in bookmarks {
        if !electerm_is_ssh(bookmark.bookmark_type.as_deref()) {
            continue;
        }
        let Some(hostname) = trimmed(bookmark.host) else {
            continue;
        };
        let name =
            first_trimmed([bookmark.title, bookmark.name]).unwrap_or_else(|| hostname.clone());
        let bookmark_id = first_trimmed([bookmark.id, bookmark.alternate_id]);
        let category_id = first_trimmed([bookmark.category_id, bookmark.category]);
        let group = category_id
            .as_ref()
            .and_then(|id| group_names.get(id).cloned())
            .or_else(|| bookmark_id.and_then(|id| bookmark_groups.get(&id).cloned()));
        let identity_file = [bookmark.identity_file, bookmark.private_key_path]
            .into_iter()
            .find_map(concrete_identity_path);
        let auth_value = bookmark.auth_type.as_deref().or_else(|| {
            bookmark
                .bookmark_type
                .as_deref()
                .filter(|value| !value.trim().eq_ignore_ascii_case("ssh"))
        });
        let hint = auth_hint(auth_value, identity_file.is_some());
        push_candidate(
            &mut candidates,
            &mut seen,
            ParsedCandidate {
                name,
                hostname,
                port: bookmark.port.unwrap_or(22),
                username: trimmed(bookmark.username),
                group,
                auth_hint: hint,
                identity_file,
            },
        );
    }
    Ok(candidates)
}

fn validate_import_path(path: &str) -> Result<PathBuf> {
    if path.trim().is_empty() || path.contains('\0') || path.len() > 32_768 {
        return Err(LumaError::InvalidInput(
            "import file path is invalid".into(),
        ));
    }
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err(LumaError::InvalidInput(
            "import file path must be absolute".into(),
        ));
    }
    if !path.is_file() {
        return Err(LumaError::InvalidInput(
            "selected import file does not exist".into(),
        ));
    }
    Ok(path)
}

fn read_candidates(source: ImportSource, path: &str) -> Result<Vec<ParsedCandidate>> {
    let path = validate_import_path(path)?;
    if fs::metadata(&path)?.len() > MAX_IMPORT_FILE_BYTES {
        return Err(LumaError::InvalidInput(format!(
            "{} import file exceeds the size limit",
            source.label()
        )));
    }
    let bytes = fs::read(path)?;
    let contents = String::from_utf8(bytes).map_err(|_| {
        LumaError::InvalidInput(format!(
            "could not parse {} config: file is not valid UTF-8",
            source.label()
        ))
    })?;
    match source {
        ImportSource::Tabby => parse_tabby(&contents),
        ImportSource::Electerm => parse_electerm(&contents),
    }
}

pub async fn preview_hosts(
    pool: &SqlitePool,
    source: String,
    path: String,
) -> Result<Vec<ImportedHostCandidate>> {
    let source = ImportSource::parse(&source)?;
    let candidates = read_candidates(source, &path)?;
    let rows = sqlx::query("SELECT name FROM hosts")
        .fetch_all(pool)
        .await?;
    let existing: HashSet<String> = rows
        .iter()
        .map(|row| row.get::<String, _>("name").to_ascii_lowercase())
        .collect();
    Ok(candidates
        .iter()
        .map(|candidate| candidate.public(existing.contains(&candidate.name.to_ascii_lowercase())))
        .collect())
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

fn authentication_type(candidate: &ParsedCandidate) -> &'static str {
    if candidate.identity_file.is_some() {
        return "key";
    }
    match candidate.auth_hint.as_str() {
        "password" | "keyboard-interactive" => "interactive",
        "public-key" | "agent" | "unknown" => "agent",
        _ => "agent",
    }
}

struct PreparedHost {
    id: String,
    candidate: ParsedCandidate,
    input: HostInput,
    generated_key_id: Option<String>,
}

pub async fn apply_hosts(
    pool: &SqlitePool,
    source: String,
    path: String,
    request: ImportHostsRequest,
) -> Result<ImportedHostsResult> {
    let source = ImportSource::parse(&source)?;
    if request.selected_names.len() > MAX_IMPORT_ENTRIES {
        return Err(LumaError::InvalidInput(format!(
            "at most {MAX_IMPORT_ENTRIES} hosts can be imported at once"
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

    let parsed = read_candidates(source, &path)?;
    let available: HashSet<String> = parsed
        .iter()
        .map(|candidate| candidate.name.to_ascii_lowercase())
        .collect();
    if let Some(unknown) = selected.iter().find(|name| !available.contains(*name)) {
        return Err(LumaError::InvalidInput(format!(
            "import host entry was not found: {unknown}"
        )));
    }

    let existing_host_rows = sqlx::query("SELECT name FROM hosts")
        .fetch_all(pool)
        .await?;
    let mut existing_names: HashSet<String> = existing_host_rows
        .iter()
        .map(|row| row.get::<String, _>("name").to_ascii_lowercase())
        .collect();
    let group_rows = sqlx::query("SELECT id, name FROM host_groups")
        .fetch_all(pool)
        .await?;
    let mut group_ids: HashMap<String, String> = group_rows
        .iter()
        .map(|row| {
            (
                row.get::<String, _>("name").to_ascii_lowercase(),
                row.get::<String, _>("id"),
            )
        })
        .collect();

    let mut skipped_existing = Vec::new();
    let mut new_groups = Vec::new();
    let mut prepared = Vec::new();
    for candidate in parsed {
        let normalized_name = candidate.name.to_ascii_lowercase();
        if !selected.contains(&normalized_name) {
            continue;
        }
        if !existing_names.insert(normalized_name) {
            skipped_existing.push(candidate.name);
            continue;
        }

        let group_id = if let Some(group_name) = &candidate.group {
            let normalized_group = group_name.to_ascii_lowercase();
            if let Some(group_id) = group_ids.get(&normalized_group) {
                Some(group_id.clone())
            } else {
                host_groups::validate_name(group_name)?;
                let group_id = uuid::Uuid::new_v4().to_string();
                group_ids.insert(normalized_group, group_id.clone());
                new_groups.push((group_id.clone(), group_name.clone()));
                Some(group_id)
            }
        } else {
            None
        };

        let generated_key_id = candidate
            .identity_file
            .as_ref()
            .map(|_| uuid::Uuid::new_v4().to_string());
        if let Some(identity_file) = &candidate.identity_file {
            let mut key_name = format!("{} key", candidate.name);
            key_name.truncate(key_name.floor_char_boundary(128));
            key_references::validate(&KeyReferenceInput {
                name: key_name,
                public_key: None,
                storage_mode: "local-path".into(),
                local_path: Some(expanded_identity_file(identity_file)),
                fingerprint: None,
                certificate: None,
                private_key: None,
                passphrase: None,
            })?;
        }
        let input = HostInput {
            name: candidate.name.clone(),
            hostname: candidate.hostname.clone(),
            port: i64::from(candidate.port),
            username: candidate.username.clone(),
            group_id,
            authentication_type: authentication_type(&candidate).into(),
            key_id: generated_key_id.clone(),
            identity_id: None,
            proxy_jump_host_id: None,
            startup_command: None,
            working_directory: None,
            environment: None,
            tags: Vec::new(),
            favorite: false,
        };
        hosts::validate_fields(&input)?;
        prepared.push(PreparedHost {
            id: uuid::Uuid::new_v4().to_string(),
            candidate,
            input,
            generated_key_id,
        });
    }

    let mut transaction = pool.begin().await?;
    for (group_id, group_name) in &new_groups {
        sqlx::query(
            "INSERT INTO host_groups (id, name, parent_id, sort_order) VALUES (?1, ?2, NULL, 0)",
        )
        .bind(group_id)
        .bind(group_name.trim())
        .execute(&mut *transaction)
        .await?;
    }

    for prepared_host in &prepared {
        let key_id = if let Some(identity_file) = &prepared_host.candidate.identity_file {
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
                let key_id = prepared_host
                    .generated_key_id
                    .clone()
                    .expect("identity file imports always prepare a key id");
                let mut key_name = format!("{} key", prepared_host.candidate.name);
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
                 id, name, hostname, port, username, group_id, auth_type, key_id,
                 proxy_jump_host_id, tags, favorite
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, '[]', 0)",
        )
        .bind(&prepared_host.id)
        .bind(prepared_host.input.name.trim())
        .bind(prepared_host.input.hostname.trim())
        .bind(prepared_host.input.port)
        .bind(prepared_host.input.username.as_deref().map(str::trim))
        .bind(&prepared_host.input.group_id)
        .bind(&prepared_host.input.authentication_type)
        .bind(key_id)
        .execute(&mut *transaction)
        .await?;
    }
    transaction.commit().await?;

    let mut imported_hosts = Vec::with_capacity(prepared.len());
    for prepared_host in prepared {
        if let Some(host) = hosts::get(pool, &prepared_host.id).await? {
            imported_hosts.push(host);
        }
    }
    Ok(ImportedHostsResult {
        imported_hosts,
        created_groups: new_groups.into_iter().map(|(_, name)| name).collect(),
        skipped_existing,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tabby_ssh_profiles_and_skips_other_entries() {
        let fixture = r#"
groups:
  - id: work-id
    name: " Work "
profiles:
  - type: ssh
    name: " Production "
    group: work-id
    options:
      host: " prod.example.com "
      port: "2222"
      user: " deploy "
      auth: password
  - type: ssh
    name: production
    options:
      host: duplicate.example.com
      auth: agent
  - type: serial
    name: Serial device
    options:
      host: serial.example.com
  - type: ssh
    name: Empty host
    options:
      host: "   "
  - type: ssh
    name: Key host
    options:
      host: key.example.com
      auth: publicKey
      identityFile: ~/.ssh/id_ed25519
"#;
        let candidates = parse_tabby(fixture).unwrap();
        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[0].name, "Production");
        assert_eq!(candidates[0].hostname, "prod.example.com");
        assert_eq!(candidates[0].port, 2222);
        assert_eq!(candidates[0].username.as_deref(), Some("deploy"));
        assert_eq!(candidates[0].group.as_deref(), Some("Work"));
        assert_eq!(candidates[0].auth_hint, "password");
        assert_eq!(candidates[1].auth_hint, "public-key");
        assert_eq!(
            candidates[1].identity_file.as_deref(),
            Some("~/.ssh/id_ed25519")
        );
    }

    #[test]
    fn parses_electerm_object_export_with_group_membership() {
        let fixture = r#"{
          "bookmarks": [
            {"id":"one","title":" Primary ","host":" one.example.com ","port":"2200","username":" alice ","type":"ssh","authType":"privateKey"},
            {"id":"two","name":"primary","host":"duplicate.example.com","type":"ssh","authType":"agent"},
            {"id":"three","title":"Telnet","host":"telnet.example.com","type":"telnet"},
            {"id":"four","title":"Empty","host":"  ","type":"ssh"},
            {"id":"five","title":"Keyboard","host":"kbd.example.com","type":"ssh","authType":"keyboard_interactive","category":"ops"}
          ],
          "bookmarkGroups": [
            {"id":"work","title":"Work","bookmarkIds":["one"]},
            {"id":"ops","name":"Operations","bookmarkIds":[]}
          ]
        }"#;
        let candidates = parse_electerm(fixture).unwrap();
        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[0].name, "Primary");
        assert_eq!(candidates[0].hostname, "one.example.com");
        assert_eq!(candidates[0].port, 2200);
        assert_eq!(candidates[0].username.as_deref(), Some("alice"));
        assert_eq!(candidates[0].group.as_deref(), Some("Work"));
        assert_eq!(candidates[0].auth_hint, "public-key");
        assert_eq!(candidates[1].group.as_deref(), Some("Operations"));
        assert_eq!(candidates[1].auth_hint, "keyboard-interactive");
    }

    #[test]
    fn parses_electerm_bare_array_and_ssh_shaped_bookmarks() {
        let fixture = r#"[
          {"title":"Agent","host":"agent.example.com","username":"root","authType":"agent"},
          {"name":"Password","host":"password.example.com","port":2022,"type":"password"},
          {"name":"Local","host":"localhost","type":"local"},
          {"name":"No host","type":"ssh"}
        ]"#;
        let candidates = parse_electerm(fixture).unwrap();
        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[0].port, 22);
        assert_eq!(candidates[0].auth_hint, "agent");
        assert_eq!(candidates[1].hostname, "password.example.com");
        assert_eq!(candidates[1].port, 2022);
        assert_eq!(candidates[1].auth_hint, "password");
    }

    #[test]
    fn maps_auth_hints_without_importing_secrets() {
        assert_eq!(auth_hint(Some("password"), false), "password");
        assert_eq!(
            auth_hint(Some("keyboard_interactive"), false),
            "keyboard-interactive"
        );
        assert_eq!(auth_hint(Some("publicKey"), false), "public-key");
        assert_eq!(auth_hint(Some("agent"), false), "agent");
        assert_eq!(auth_hint(Some("unsupported"), false), "unknown");

        let candidate = ParsedCandidate {
            name: "Key metadata".into(),
            hostname: "key.example.com".into(),
            port: 22,
            username: None,
            group: None,
            auth_hint: "public-key".into(),
            identity_file: None,
        };
        assert_eq!(authentication_type(&candidate), "agent");
    }
}
