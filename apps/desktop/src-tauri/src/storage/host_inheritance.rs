//! Group-level configuration inheritance.
//!
//! A host row stores exactly what the user typed into that host. Anything the
//! host leaves unset may instead come from its group, or from that group's
//! parent, and so on up the chain. [`resolve_effective_host`] is the single
//! pure function that decides this; everything that connects to a host runs its
//! result rather than the raw row.
//!
//! Two rules keep the semantics honest:
//!
//! * "Unset" must be distinguishable from "explicitly set to empty". Every
//!   inheritable column is nullable on both sides, so `NULL` is unset and an
//!   empty string never reaches storage (writes trim to `NULL`).
//! * `auth_type` and `key_id` are **not** inheritable. `auth_type` is NOT NULL
//!   with a default of `interactive`, so a host that deliberately chose
//!   interactive authentication is indistinguishable from one that never
//!   touched the field, and inheriting it would silently change how a host
//!   authenticates. Groups express credentials through `identity_id`, which is
//!   nullable and already replaces username/auth/key as a unit.
//!
//! `transport` is the one NOT NULL column that does inherit, because its
//! default (`ssh`) is also its safe fallback: a mis-inherited transport changes
//! how the session is carried, never who may open it, and `auto` falls back to
//! SSH on its own. The cost is that a host inside a Mosh group cannot pin
//! itself back to plain SSH — it would need a host-level "explicitly ssh"
//! marker, which means a `hosts` column this feature does not add.

use std::collections::{BTreeMap, HashMap, HashSet};

use serde::Serialize;
use sqlx::SqlitePool;

use crate::errors::Result;
use crate::storage::host_groups::{self, HostGroup};
use crate::storage::hosts::{default_transport, Host, DEFAULT_AUTHENTICATION_TYPE};

/// Depth cap for the group chain, mirroring the proxy-jump cap in
/// `crate::ssh`. Nesting deeper than this is a mistake, not a use case.
const MAX_GROUP_DEPTH: usize = 16;

/// Where an effective value came from. Serializes to `"host"`,
/// `"group:<id>"`, or `"default"` so the editor can label a field as
/// inherited, overridden, or simply unset.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(into = "String")]
pub enum FieldOrigin {
    Host,
    Group(String),
    Default,
}

impl From<FieldOrigin> for String {
    fn from(origin: FieldOrigin) -> Self {
        match origin {
            FieldOrigin::Host => "host".into(),
            FieldOrigin::Group(id) => format!("group:{id}"),
            FieldOrigin::Default => "default".into(),
        }
    }
}

/// Per-field provenance for an [`EffectiveHost`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldOrigins {
    pub username: FieldOrigin,
    pub identity_id: FieldOrigin,
    pub proxy_jump_host_id: FieldOrigin,
    pub startup_command: FieldOrigin,
    pub working_directory: FieldOrigin,
    pub tab_color: FieldOrigin,
    pub transport: FieldOrigin,
    pub mosh_server_path: FieldOrigin,
    pub mosh_port_range: FieldOrigin,
    /// Environment variables merge instead of replacing wholesale, so the
    /// origin is recorded per variable name.
    pub environment: BTreeMap<String, FieldOrigin>,
}

/// A host with inheritance applied, plus the provenance of every field that
/// could have been inherited.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveHost {
    pub host: Host,
    pub origins: FieldOrigins,
}

fn nearest<'a, T>(
    chain: &'a [HostGroup],
    pick: impl Fn(&'a HostGroup) -> Option<&'a T>,
) -> Option<(&'a T, &'a str)> {
    chain
        .iter()
        .find_map(|group| pick(group).map(|value| (value, group.id.as_str())))
}

fn resolve_text(
    host_value: &Option<String>,
    chain: &[HostGroup],
    pick: impl for<'a> Fn(&'a HostGroup) -> Option<&'a String>,
) -> (Option<String>, FieldOrigin) {
    if let Some(value) = host_value {
        return (Some(value.clone()), FieldOrigin::Host);
    }
    match nearest(chain, pick) {
        Some((value, group_id)) => (
            Some(value.clone()),
            FieldOrigin::Group(group_id.to_string()),
        ),
        None => (None, FieldOrigin::Default),
    }
}

/// Resolve `host` against `chain`, which must be ordered nearest ancestor
/// first (the host's own group, then its parent, and so on).
///
/// Each field is taken from the host when the host sets it, otherwise from the
/// nearest ancestor group that sets it, otherwise from the built-in default.
pub fn resolve_effective_host(host: &Host, chain: &[HostGroup]) -> EffectiveHost {
    let mut effective = host.clone();

    // Credentials. A host that configures any credential of its own owns the
    // whole credential slot: inheriting an identity on top of a host key would
    // replace that key, which is never what "the group has a default" means.
    let host_defines_credentials = host.username.is_some()
        || host.key_id.is_some()
        || host.authentication_type != DEFAULT_AUTHENTICATION_TYPE;
    // The nearest ancestor that configures credentials at all supplies both
    // fields; mixing an identity from one group with a username from another
    // would depend on which field happened to be set where.
    let credential_group = chain
        .iter()
        .find(|group| group.defaults.identity_id.is_some() || group.defaults.username.is_some());

    let (identity_id, identity_origin) = if let Some(identity_id) = &host.identity_id {
        (Some(identity_id.clone()), FieldOrigin::Host)
    } else if host_defines_credentials {
        (None, FieldOrigin::Host)
    } else {
        match credential_group.and_then(|group| {
            group
                .defaults
                .identity_id
                .as_ref()
                .map(|identity_id| (identity_id, group.id.as_str()))
        }) {
            Some((identity_id, group_id)) => (
                Some(identity_id.clone()),
                FieldOrigin::Group(group_id.to_string()),
            ),
            None => (None, FieldOrigin::Default),
        }
    };

    // An identity carries its own username (see `resolve_host_identity`), so a
    // group username is only consulted when no identity is in play.
    let (username, username_origin) = if let Some(username) = &host.username {
        (Some(username.clone()), FieldOrigin::Host)
    } else if identity_id.is_some() {
        (None, identity_origin.clone())
    } else {
        match credential_group.and_then(|group| {
            group
                .defaults
                .username
                .as_ref()
                .map(|username| (username, group.id.as_str()))
        }) {
            Some((username, group_id)) => (
                Some(username.clone()),
                FieldOrigin::Group(group_id.to_string()),
            ),
            None => (None, FieldOrigin::Default),
        }
    };

    // A group jump host must never be the host being resolved: every host in
    // the group would otherwise proxy through itself.
    let (proxy_jump_host_id, proxy_jump_origin) = resolve_text(
        &host.proxy_jump_host_id,
        chain,
        |group: &HostGroup| -> Option<&String> {
            group
                .defaults
                .proxy_jump_host_id
                .as_ref()
                .filter(|candidate| candidate.as_str() != host.id)
        },
    );

    let (startup_command, startup_command_origin) =
        resolve_text(&host.startup_command, chain, |group| {
            group.defaults.startup_command.as_ref()
        });
    let (working_directory, working_directory_origin) =
        resolve_text(&host.working_directory, chain, |group| {
            group.defaults.working_directory.as_ref()
        });
    let (tab_color, tab_color_origin) = resolve_text(&host.tab_color, chain, |group| {
        group.defaults.tab_color.as_ref()
    });
    let (mosh_server_path, mosh_server_path_origin) =
        resolve_text(&host.mosh_server_path, chain, |group| {
            group.defaults.mosh_server_path.as_ref()
        });
    let (mosh_port_range, mosh_port_range_origin) =
        resolve_text(&host.mosh_port_range, chain, |group| {
            group.defaults.mosh_port_range.as_ref()
        });

    // `transport` is NOT NULL on hosts, so its default doubles as "unset".
    let (transport, transport_origin) = if host.transport != default_transport() {
        (host.transport.clone(), FieldOrigin::Host)
    } else {
        match nearest(chain, |group| group.defaults.transport.as_ref()) {
            Some((transport, group_id)) => {
                (transport.clone(), FieldOrigin::Group(group_id.to_string()))
            }
            None => (default_transport(), FieldOrigin::Default),
        }
    };

    // Environment variables merge per name: the farthest ancestor is applied
    // first so nearer groups, and finally the host, override single variables
    // without discarding the rest.
    let mut environment = HashMap::new();
    let mut environment_origins = BTreeMap::new();
    for group in chain.iter().rev() {
        let Some(group_environment) = &group.defaults.environment else {
            continue;
        };
        for (name, value) in group_environment {
            environment.insert(name.clone(), value.clone());
            environment_origins.insert(name.clone(), FieldOrigin::Group(group.id.clone()));
        }
    }
    if let Some(host_environment) = &host.environment {
        for (name, value) in host_environment {
            environment.insert(name.clone(), value.clone());
            environment_origins.insert(name.clone(), FieldOrigin::Host);
        }
    }

    effective.username = username;
    effective.identity_id = identity_id;
    effective.proxy_jump_host_id = proxy_jump_host_id;
    effective.startup_command = startup_command;
    effective.working_directory = working_directory;
    effective.tab_color = tab_color;
    effective.transport = transport;
    effective.mosh_server_path = mosh_server_path;
    effective.mosh_port_range = mosh_port_range;
    effective.environment = (!environment.is_empty()).then_some(environment);

    EffectiveHost {
        host: effective,
        origins: FieldOrigins {
            username: username_origin,
            identity_id: identity_origin,
            proxy_jump_host_id: proxy_jump_origin,
            startup_command: startup_command_origin,
            working_directory: working_directory_origin,
            tab_color: tab_color_origin,
            transport: transport_origin,
            mosh_server_path: mosh_server_path_origin,
            mosh_port_range: mosh_port_range_origin,
            environment: environment_origins,
        },
    }
}

/// Walk `group_id` up to the root, nearest ancestor first.
///
/// A parent cycle cannot be created through `host_groups::update`, but a
/// corrupted or hand-edited database must not make a host unconnectable, so a
/// repeated or over-deep ancestor truncates the chain instead of failing.
pub fn build_group_chain(groups: &[HostGroup], group_id: Option<&str>) -> Vec<HostGroup> {
    let by_id: HashMap<&str, &HostGroup> = groups
        .iter()
        .map(|group| (group.id.as_str(), group))
        .collect();
    let mut chain = Vec::new();
    let mut seen = HashSet::new();
    let mut next = group_id.map(str::to_string);
    while let Some(id) = next {
        if !seen.insert(id.clone()) {
            tracing::warn!(group_id = %id, "host group parent chain contains a cycle");
            break;
        }
        if chain.len() >= MAX_GROUP_DEPTH {
            tracing::warn!(group_id = %id, "host group parent chain is too deep");
            break;
        }
        let Some(group) = by_id.get(id.as_str()) else {
            break;
        };
        next = group.parent_id.clone();
        chain.push((*group).clone());
    }
    chain
}

/// Load the group chain for `host` and resolve it. Groups are read from the
/// host's own vault, which is also what keeps a chain from crossing vaults.
pub async fn effective_host(pool: &SqlitePool, host: Host) -> Result<EffectiveHost> {
    let Some(group_id) = host.group_id.clone() else {
        return Ok(resolve_effective_host(&host, &[]));
    };
    let groups = host_groups::list(pool, Some(&host.vault_id)).await?;
    let chain = build_group_chain(&groups, Some(&group_id));
    Ok(resolve_effective_host(&host, &chain))
}

/// A host that configures nothing, used to preview what any host placed in a
/// group would inherit. Only the fields inheritance reads are meaningful.
fn unset_host(vault_id: String, group_id: Option<String>) -> Host {
    Host {
        id: String::new(),
        vault_id,
        name: String::new(),
        hostname: String::new(),
        port: 22,
        username: None,
        group_id,
        authentication_type: DEFAULT_AUTHENTICATION_TYPE.into(),
        key_id: None,
        identity_id: None,
        proxy_jump_host_id: None,
        startup_command: None,
        working_directory: None,
        environment: None,
        tags: Vec::new(),
        favorite: false,
        tab_color: None,
        transport: default_transport(),
        mosh_server_path: None,
        mosh_port_range: None,
        os_id: None,
        os_pretty_name: None,
        is_ephemeral: false,
    }
}

/// What a host that overrides nothing would inherit from `group_id`. This is
/// what the editor shows next to each field, so the hints follow the group
/// picker rather than the group the host was last saved into.
pub async fn group_defaults_preview(
    pool: &SqlitePool,
    group_id: Option<&str>,
) -> Result<EffectiveHost> {
    let Some(group_id) = group_id else {
        return Ok(resolve_effective_host(
            &unset_host(crate::storage::vaults::default_id(), None),
            &[],
        ));
    };
    let Some(group) = host_groups::get(pool, group_id).await? else {
        return Ok(resolve_effective_host(
            &unset_host(crate::storage::vaults::default_id(), None),
            &[],
        ));
    };
    let host = unset_host(group.vault_id.clone(), Some(group_id.to_string()));
    effective_host(pool, host).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::host_groups::HostGroupDefaults;

    fn host(name: &str) -> Host {
        Host {
            id: format!("host-{name}"),
            vault_id: "vault".into(),
            name: name.into(),
            hostname: "example.com".into(),
            port: 22,
            username: None,
            group_id: None,
            authentication_type: DEFAULT_AUTHENTICATION_TYPE.into(),
            key_id: None,
            identity_id: None,
            proxy_jump_host_id: None,
            startup_command: None,
            working_directory: None,
            environment: None,
            tags: Vec::new(),
            favorite: false,
            tab_color: None,
            transport: default_transport(),
            mosh_server_path: None,
            mosh_port_range: None,
            os_id: None,
            os_pretty_name: None,
            is_ephemeral: false,
        }
    }

    fn group(id: &str, parent_id: Option<&str>, defaults: HostGroupDefaults) -> HostGroup {
        HostGroup {
            id: id.into(),
            vault_id: "vault".into(),
            name: id.into(),
            parent_id: parent_id.map(str::to_string),
            sort_order: 0,
            defaults,
        }
    }

    fn environment(pairs: &[(&str, &str)]) -> Option<HashMap<String, String>> {
        Some(
            pairs
                .iter()
                .map(|(name, value)| ((*name).to_string(), (*value).to_string()))
                .collect(),
        )
    }

    #[test]
    fn falls_back_to_built_in_defaults_when_nothing_is_configured() {
        let resolved = resolve_effective_host(&host("bare"), &[]);
        assert_eq!(resolved.host.username, None);
        assert_eq!(resolved.host.transport, "ssh");
        assert_eq!(resolved.host.environment, None);
        assert_eq!(resolved.origins.username, FieldOrigin::Default);
        assert_eq!(resolved.origins.transport, FieldOrigin::Default);
        assert_eq!(resolved.origins.startup_command, FieldOrigin::Default);
        assert!(resolved.origins.environment.is_empty());
    }

    #[test]
    fn a_group_supplies_every_field_the_host_leaves_unset() {
        let chain = [group(
            "team",
            None,
            HostGroupDefaults {
                username: Some("deploy".into()),
                proxy_jump_host_id: Some("bastion".into()),
                startup_command: Some("tmux attach".into()),
                working_directory: Some("/srv".into()),
                tab_color: Some("#123456".into()),
                transport: Some("auto".into()),
                mosh_server_path: Some("/usr/local/bin/mosh-server".into()),
                mosh_port_range: Some("60000-60010".into()),
                ..HostGroupDefaults::default()
            },
        )];
        let resolved = resolve_effective_host(&host("bare"), &chain);

        assert_eq!(resolved.host.username.as_deref(), Some("deploy"));
        assert_eq!(resolved.host.proxy_jump_host_id.as_deref(), Some("bastion"));
        assert_eq!(
            resolved.host.startup_command.as_deref(),
            Some("tmux attach")
        );
        assert_eq!(resolved.host.working_directory.as_deref(), Some("/srv"));
        assert_eq!(resolved.host.tab_color.as_deref(), Some("#123456"));
        assert_eq!(resolved.host.transport, "auto");
        assert_eq!(
            resolved.host.mosh_server_path.as_deref(),
            Some("/usr/local/bin/mosh-server")
        );
        assert_eq!(
            resolved.host.mosh_port_range.as_deref(),
            Some("60000-60010")
        );

        let group_origin = FieldOrigin::Group("team".into());
        assert_eq!(resolved.origins.username, group_origin);
        assert_eq!(resolved.origins.proxy_jump_host_id, group_origin);
        assert_eq!(resolved.origins.startup_command, group_origin);
        assert_eq!(resolved.origins.working_directory, group_origin);
        assert_eq!(resolved.origins.tab_color, group_origin);
        assert_eq!(resolved.origins.transport, group_origin);
        assert_eq!(resolved.origins.mosh_server_path, group_origin);
        assert_eq!(resolved.origins.mosh_port_range, group_origin);
    }

    #[test]
    fn the_host_wins_over_every_group_default() {
        let mut overriding = host("explicit");
        overriding.username = Some("root".into());
        overriding.startup_command = Some("htop".into());
        overriding.working_directory = Some("/home/root".into());
        overriding.tab_color = Some("#abcdef".into());
        overriding.transport = "mosh".into();
        overriding.mosh_port_range = Some("61000".into());
        overriding.proxy_jump_host_id = Some("own-bastion".into());

        let chain = [group(
            "team",
            None,
            HostGroupDefaults {
                username: Some("deploy".into()),
                startup_command: Some("tmux attach".into()),
                working_directory: Some("/srv".into()),
                tab_color: Some("#123456".into()),
                transport: Some("auto".into()),
                mosh_port_range: Some("60000-60010".into()),
                proxy_jump_host_id: Some("group-bastion".into()),
                ..HostGroupDefaults::default()
            },
        )];
        let resolved = resolve_effective_host(&overriding, &chain);

        assert_eq!(resolved.host.username.as_deref(), Some("root"));
        assert_eq!(resolved.host.startup_command.as_deref(), Some("htop"));
        assert_eq!(
            resolved.host.working_directory.as_deref(),
            Some("/home/root")
        );
        assert_eq!(resolved.host.tab_color.as_deref(), Some("#abcdef"));
        assert_eq!(resolved.host.transport, "mosh");
        assert_eq!(resolved.host.mosh_port_range.as_deref(), Some("61000"));
        assert_eq!(
            resolved.host.proxy_jump_host_id.as_deref(),
            Some("own-bastion")
        );

        assert_eq!(resolved.origins.username, FieldOrigin::Host);
        assert_eq!(resolved.origins.startup_command, FieldOrigin::Host);
        assert_eq!(resolved.origins.transport, FieldOrigin::Host);
        assert_eq!(resolved.origins.proxy_jump_host_id, FieldOrigin::Host);
        // Not set anywhere: still a default, even next to overridden siblings.
        assert_eq!(resolved.origins.mosh_server_path, FieldOrigin::Default);
    }

    #[test]
    fn the_nearest_ancestor_that_sets_a_field_wins() {
        let chain = [
            group(
                "child",
                Some("parent"),
                HostGroupDefaults {
                    startup_command: Some("child command".into()),
                    ..HostGroupDefaults::default()
                },
            ),
            group(
                "parent",
                Some("root"),
                HostGroupDefaults {
                    startup_command: Some("parent command".into()),
                    working_directory: Some("/parent".into()),
                    ..HostGroupDefaults::default()
                },
            ),
            group(
                "root",
                None,
                HostGroupDefaults {
                    startup_command: Some("root command".into()),
                    working_directory: Some("/root".into()),
                    tab_color: Some("#000000".into()),
                    ..HostGroupDefaults::default()
                },
            ),
        ];
        let resolved = resolve_effective_host(&host("nested"), &chain);

        assert_eq!(
            resolved.host.startup_command.as_deref(),
            Some("child command")
        );
        assert_eq!(
            resolved.origins.startup_command,
            FieldOrigin::Group("child".into())
        );
        assert_eq!(resolved.host.working_directory.as_deref(), Some("/parent"));
        assert_eq!(
            resolved.origins.working_directory,
            FieldOrigin::Group("parent".into())
        );
        assert_eq!(resolved.host.tab_color.as_deref(), Some("#000000"));
        assert_eq!(
            resolved.origins.tab_color,
            FieldOrigin::Group("root".into())
        );
    }

    #[test]
    fn a_group_identity_only_reaches_hosts_without_credentials_of_their_own() {
        let chain = [group(
            "team",
            None,
            HostGroupDefaults {
                identity_id: Some("identity-1".into()),
                ..HostGroupDefaults::default()
            },
        )];

        let inherited = resolve_effective_host(&host("bare"), &chain);
        assert_eq!(inherited.host.identity_id.as_deref(), Some("identity-1"));
        assert_eq!(
            inherited.origins.identity_id,
            FieldOrigin::Group("team".into())
        );
        // The identity supplies the username, so the field stays unset and
        // reports the identity's origin rather than claiming a host value.
        assert_eq!(inherited.host.username, None);

        let mut with_key = host("key-auth");
        with_key.authentication_type = "key".into();
        with_key.key_id = Some("key-1".into());
        let resolved = resolve_effective_host(&with_key, &chain);
        assert_eq!(resolved.host.identity_id, None);
        assert_eq!(resolved.origins.identity_id, FieldOrigin::Host);
        assert_eq!(resolved.host.authentication_type, "key");
        assert_eq!(resolved.host.key_id.as_deref(), Some("key-1"));

        let mut with_username = host("named");
        with_username.username = Some("root".into());
        let resolved = resolve_effective_host(&with_username, &chain);
        assert_eq!(resolved.host.identity_id, None);
        assert_eq!(resolved.host.username.as_deref(), Some("root"));
    }

    #[test]
    fn a_key_only_host_still_inherits_a_group_username() {
        let chain = [group(
            "team",
            None,
            HostGroupDefaults {
                username: Some("deploy".into()),
                ..HostGroupDefaults::default()
            },
        )];
        let mut with_key = host("key-auth");
        with_key.authentication_type = "key".into();
        with_key.key_id = Some("key-1".into());

        let resolved = resolve_effective_host(&with_key, &chain);
        assert_eq!(resolved.host.username.as_deref(), Some("deploy"));
        assert_eq!(resolved.origins.username, FieldOrigin::Group("team".into()));
        assert_eq!(resolved.host.identity_id, None);
    }

    #[test]
    fn the_nearest_credential_group_owns_both_username_and_identity() {
        let chain = [
            group(
                "child",
                Some("root"),
                HostGroupDefaults {
                    username: Some("deploy".into()),
                    ..HostGroupDefaults::default()
                },
            ),
            group(
                "root",
                None,
                HostGroupDefaults {
                    identity_id: Some("identity-1".into()),
                    ..HostGroupDefaults::default()
                },
            ),
        ];
        let resolved = resolve_effective_host(&host("nested"), &chain);
        assert_eq!(resolved.host.username.as_deref(), Some("deploy"));
        assert_eq!(resolved.host.identity_id, None);
    }

    #[test]
    fn a_host_never_inherits_itself_as_a_jump_host() {
        let self_referencing = host("bastion");
        let chain = [
            group(
                "child",
                Some("root"),
                HostGroupDefaults {
                    proxy_jump_host_id: Some(self_referencing.id.clone()),
                    ..HostGroupDefaults::default()
                },
            ),
            group(
                "root",
                None,
                HostGroupDefaults {
                    proxy_jump_host_id: Some("other-bastion".into()),
                    ..HostGroupDefaults::default()
                },
            ),
        ];
        let resolved = resolve_effective_host(&self_referencing, &chain);
        assert_eq!(
            resolved.host.proxy_jump_host_id.as_deref(),
            Some("other-bastion")
        );
        assert_eq!(
            resolved.origins.proxy_jump_host_id,
            FieldOrigin::Group("root".into())
        );
    }

    #[test]
    fn environment_variables_merge_per_name() {
        let chain = [
            group(
                "child",
                Some("root"),
                HostGroupDefaults {
                    environment: environment(&[("SHARED", "child"), ("CHILD", "1")]),
                    ..HostGroupDefaults::default()
                },
            ),
            group(
                "root",
                None,
                HostGroupDefaults {
                    environment: environment(&[("SHARED", "root"), ("ROOT", "1")]),
                    ..HostGroupDefaults::default()
                },
            ),
        ];
        let mut with_environment = host("env");
        with_environment.environment = environment(&[("SHARED", "host"), ("HOST", "1")]);

        let resolved = resolve_effective_host(&with_environment, &chain);
        let merged = resolved.host.environment.unwrap();
        assert_eq!(merged.get("SHARED").map(String::as_str), Some("host"));
        assert_eq!(merged.get("CHILD").map(String::as_str), Some("1"));
        assert_eq!(merged.get("ROOT").map(String::as_str), Some("1"));
        assert_eq!(merged.get("HOST").map(String::as_str), Some("1"));

        assert_eq!(resolved.origins.environment["SHARED"], FieldOrigin::Host);
        assert_eq!(resolved.origins.environment["HOST"], FieldOrigin::Host);
        assert_eq!(
            resolved.origins.environment["CHILD"],
            FieldOrigin::Group("child".into())
        );
        assert_eq!(
            resolved.origins.environment["ROOT"],
            FieldOrigin::Group("root".into())
        );
    }

    #[test]
    fn origins_serialize_to_stable_strings() {
        let chain = [group(
            "team",
            None,
            HostGroupDefaults {
                startup_command: Some("tmux".into()),
                ..HostGroupDefaults::default()
            },
        )];
        let mut overriding = host("mixed");
        overriding.username = Some("root".into());
        let resolved = resolve_effective_host(&overriding, &chain);
        let json = serde_json::to_value(&resolved.origins).unwrap();
        assert_eq!(json["username"], "host");
        assert_eq!(json["startupCommand"], "group:team");
        assert_eq!(json["tabColor"], "default");
    }

    #[test]
    fn the_chain_is_ordered_nearest_first_and_stops_at_the_root() {
        let groups = [
            group("child", Some("parent"), HostGroupDefaults::default()),
            group("parent", Some("root"), HostGroupDefaults::default()),
            group("root", None, HostGroupDefaults::default()),
            group("unrelated", None, HostGroupDefaults::default()),
        ];
        let chain = build_group_chain(&groups, Some("child"));
        let ids: Vec<&str> = chain.iter().map(|group| group.id.as_str()).collect();
        assert_eq!(ids, ["child", "parent", "root"]);

        assert!(build_group_chain(&groups, None).is_empty());
        assert!(build_group_chain(&groups, Some("missing")).is_empty());
    }

    #[test]
    fn a_parent_cycle_truncates_the_chain_instead_of_looping() {
        let groups = [
            group("a", Some("b"), HostGroupDefaults::default()),
            group("b", Some("a"), HostGroupDefaults::default()),
        ];
        let chain = build_group_chain(&groups, Some("a"));
        let ids: Vec<&str> = chain.iter().map(|group| group.id.as_str()).collect();
        assert_eq!(ids, ["a", "b"]);

        // A self-parenting group is the degenerate case of the same cycle.
        let groups = [group("loop", Some("loop"), HostGroupDefaults::default())];
        assert_eq!(build_group_chain(&groups, Some("loop")).len(), 1);
    }

    #[tokio::test]
    async fn effective_host_resolves_a_stored_nested_chain() {
        use crate::storage::host_groups::{create as create_group, HostGroupInput};
        use crate::storage::hosts::{create as create_host, HostInput};
        use crate::storage::vaults;

        let pool = crate::storage::init_in_memory().await.unwrap();
        let mut parent_input = HostGroupInput {
            vault_id: vaults::default_id(),
            name: "Production".into(),
            parent_id: None,
            sort_order: 0,
            defaults: HostGroupDefaults {
                username: Some("deploy".into()),
                startup_command: Some("tmux attach".into()),
                transport: Some("auto".into()),
                ..HostGroupDefaults::default()
            },
        };
        parent_input.defaults.environment = environment(&[("REGION", "eu")]);
        let parent = create_group(&pool, parent_input).await.unwrap();
        let child = create_group(
            &pool,
            HostGroupInput {
                vault_id: vaults::default_id(),
                name: "Web".into(),
                parent_id: Some(parent.id.clone()),
                sort_order: 0,
                defaults: HostGroupDefaults {
                    startup_command: Some("tmux attach web".into()),
                    environment: environment(&[("TIER", "web")]),
                    ..HostGroupDefaults::default()
                },
            },
        )
        .await
        .unwrap();

        let stored = create_host(
            &pool,
            HostInput {
                vault_id: vaults::default_id(),
                name: "web-1".into(),
                hostname: "web-1.example.com".into(),
                port: 22,
                username: None,
                group_id: Some(child.id.clone()),
                authentication_type: "interactive".into(),
                key_id: None,
                identity_id: None,
                proxy_jump_host_id: None,
                startup_command: None,
                working_directory: None,
                environment: None,
                tags: vec![],
                favorite: false,
                tab_color: None,
                transport: default_transport(),
                mosh_server_path: None,
                mosh_port_range: None,
            },
        )
        .await
        .unwrap();

        let resolved = effective_host(&pool, stored.clone()).await.unwrap();
        assert_eq!(resolved.host.username.as_deref(), Some("deploy"));
        assert_eq!(
            resolved.origins.username,
            FieldOrigin::Group(parent.id.clone())
        );
        assert_eq!(
            resolved.host.startup_command.as_deref(),
            Some("tmux attach web")
        );
        assert_eq!(
            resolved.origins.startup_command,
            FieldOrigin::Group(child.id.clone())
        );
        assert_eq!(resolved.host.transport, "auto");
        let merged = resolved.host.environment.unwrap();
        assert_eq!(merged["REGION"], "eu");
        assert_eq!(merged["TIER"], "web");

        // The stored row is untouched: inheritance is a read-time view.
        let raw = crate::storage::hosts::get(&pool, &stored.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(raw.username, None);
        assert_eq!(raw.startup_command, None);
        assert_eq!(raw.transport, "ssh");

        // A host outside any group resolves to itself.
        let mut orphan = raw.clone();
        orphan.group_id = None;
        let ungrouped = effective_host(&pool, orphan).await.unwrap();
        assert_eq!(ungrouped.host.username, None);
        assert_eq!(ungrouped.host.transport, "ssh");
        assert_eq!(ungrouped.origins.username, FieldOrigin::Default);
    }

    #[tokio::test]
    async fn the_group_preview_reports_only_what_a_group_would_supply() {
        use crate::storage::host_groups::{create as create_group, HostGroupInput};
        use crate::storage::vaults;

        let pool = crate::storage::init_in_memory().await.unwrap();
        let group = create_group(
            &pool,
            HostGroupInput {
                vault_id: vaults::default_id(),
                name: "Team".into(),
                parent_id: None,
                sort_order: 0,
                defaults: HostGroupDefaults {
                    username: Some("deploy".into()),
                    transport: Some("auto".into()),
                    ..HostGroupDefaults::default()
                },
            },
        )
        .await
        .unwrap();

        let preview = group_defaults_preview(&pool, Some(&group.id))
            .await
            .unwrap();
        assert_eq!(preview.host.username.as_deref(), Some("deploy"));
        assert_eq!(
            preview.origins.username,
            FieldOrigin::Group(group.id.clone())
        );
        assert_eq!(preview.host.transport, "auto");
        assert_eq!(preview.origins.startup_command, FieldOrigin::Default);
        assert_eq!(preview.host.startup_command, None);

        // No group, or a group that has since been deleted: nothing inherits.
        for missing in [None, Some("does-not-exist")] {
            let preview = group_defaults_preview(&pool, missing).await.unwrap();
            assert_eq!(preview.host.username, None);
            assert_eq!(preview.origins.username, FieldOrigin::Default);
            assert_eq!(preview.host.transport, "ssh");
        }
    }

    #[test]
    fn a_chain_deeper_than_the_cap_is_truncated() {
        let mut groups = Vec::new();
        for index in 0..(MAX_GROUP_DEPTH + 5) {
            let parent = (index + 1 < MAX_GROUP_DEPTH + 5).then(|| format!("group-{}", index + 1));
            groups.push(group(
                &format!("group-{index}"),
                parent.as_deref(),
                HostGroupDefaults::default(),
            ));
        }
        let chain = build_group_chain(&groups, Some("group-0"));
        assert_eq!(chain.len(), MAX_GROUP_DEPTH);
    }
}
