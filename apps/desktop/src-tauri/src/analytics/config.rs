//! Compile-time analytics configuration.
//!
//! The host and app key are baked in at build time. Both are overridable with
//! `LUMA_ANALYTICS_HOST` / `LUMA_ANALYTICS_KEY` so CI can point a build at a
//! staging instance, or disable analytics for a build by setting either to a
//! value that fails validation (`LUMA_ANALYTICS_KEY=off`). An unset or empty
//! override keeps the default, so a missing CI variable cannot silently ship a
//! release that reports nothing.
//!
//! An Aptabase app key is not a secret — it ships inside every binary and only
//! names which project events land in. It is still kept out of logs, because a
//! log line naming the ingest host is a fingerprint of the deployment.

use crate::errors::{LumaError, Result};

/// Luma's self-hosted Aptabase instance. Self-hosted only: an `A-US-`/`A-EU-`
/// key is rejected below so a misconfigured build can never send Luma users'
/// data to aptabase.com.
const DEFAULT_HOST: &str = "https://aptabase.n1.bwmp.dev";
const DEFAULT_APP_KEY: &str = "A-SH-8606010133";

/// Only self-hosted keys are accepted. See `DEFAULT_HOST`.
const SELF_HOSTED_REGION: &str = "SH";

pub(super) struct Config {
    pub app_key: String,
    pub endpoint: reqwest::Url,
}

impl Config {
    /// `None` when this build carries no analytics configuration, or when what
    /// it carries is malformed. Deliberately never panics: a bad host disables
    /// analytics rather than taking the app down at startup.
    pub(super) fn from_build() -> Option<Self> {
        // An override is only honoured when it is non-empty, so an unset — or
        // empty — CI variable falls back to the shipped default rather than
        // silently producing an analytics-dead release. Setting an override to
        // a deliberately invalid value (e.g. "off") disables analytics, since
        // `parse` rejects it.
        let host = override_or(option_env!("LUMA_ANALYTICS_HOST"), DEFAULT_HOST);
        let app_key = override_or(option_env!("LUMA_ANALYTICS_KEY"), DEFAULT_APP_KEY);
        // The error is dropped rather than logged: it would name the host.
        Self::parse(host, app_key).ok()
    }

    fn parse(host: &str, app_key: &str) -> Result<Self> {
        if host.is_empty() || app_key.is_empty() {
            return Err(LumaError::InvalidInput(
                "analytics is not configured".into(),
            ));
        }
        validate_app_key(app_key)?;
        let url = validate_host(host)?;
        let endpoint = reqwest::Url::parse(&format!(
            "{}/api/v0/events",
            url.as_str().trim_end_matches('/')
        ))
        .map_err(|_| LumaError::InvalidInput("analytics host is not a valid URL".into()))?;
        Ok(Self {
            app_key: app_key.to_string(),
            endpoint,
        })
    }
}

/// Keeps the key and endpoint out of any `{:?}` a future caller reaches for.
/// The logging redaction in `logging/mod.rs` matches `key=`-shaped text, not a
/// bare URL, so this is the only guard.
impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Config { .. }")
    }
}

fn override_or<'a>(value: Option<&'a str>, fallback: &'a str) -> &'a str {
    match value.map(str::trim) {
        Some(value) if !value.is_empty() => value,
        _ => fallback,
    }
}

/// Aptabase keys are `A-<REGION>-<random>`. Only `SH` is accepted.
fn validate_app_key(app_key: &str) -> Result<()> {
    let parts: Vec<&str> = app_key.split('-').collect();
    let valid = parts.len() == 3
        && parts[0] == "A"
        && parts[1] == SELF_HOSTED_REGION
        && !parts[2].is_empty()
        && parts[2].chars().all(|c| c.is_ascii_alphanumeric());
    if !valid {
        return Err(LumaError::InvalidInput(
            "analytics app key is not a self-hosted Aptabase key".into(),
        ));
    }
    Ok(())
}

/// HTTPS, no credentials, no query or fragment — the same shape
/// `sync::providers::validate_https_url` enforces for sync endpoints. `http://`
/// is additionally allowed in debug builds so `pnpm tauri dev` can point at a
/// local Aptabase.
fn validate_host(host: &str) -> Result<reqwest::Url> {
    let url = reqwest::Url::parse(host)
        .map_err(|_| LumaError::InvalidInput("analytics host is not a valid URL".into()))?;
    let scheme_ok = url.scheme() == "https" || (cfg!(debug_assertions) && url.scheme() == "http");
    if !scheme_ok {
        return Err(LumaError::InvalidInput(
            "analytics host must use https".into(),
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(LumaError::InvalidInput(
            "analytics host must not embed credentials".into(),
        ));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(LumaError::InvalidInput(
            "analytics host must not include a query or fragment".into(),
        ));
    }
    if url.host_str().is_none() {
        return Err(LumaError::InvalidInput(
            "analytics host has no hostname".into(),
        ));
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_a_self_hosted_key_and_https_host() {
        let config = Config::parse("https://analytics.example.dev", "A-SH-8606010133").unwrap();
        assert_eq!(
            config.endpoint.as_str(),
            "https://analytics.example.dev/api/v0/events"
        );
    }

    #[test]
    fn trailing_slash_does_not_double_up_the_path() {
        let config = Config::parse("https://analytics.example.dev/", "A-SH-abc123").unwrap();
        assert_eq!(
            config.endpoint.as_str(),
            "https://analytics.example.dev/api/v0/events"
        );
    }

    #[test]
    fn the_shipped_defaults_are_valid() {
        let config = Config::parse(DEFAULT_HOST, DEFAULT_APP_KEY).unwrap();
        assert!(config.endpoint.as_str().ends_with("/api/v0/events"));
    }

    #[test]
    fn an_unset_or_empty_override_keeps_the_shipped_default() {
        // A missing CI variable interpolates to "", which must not silently
        // ship a release that reports nothing.
        assert_eq!(override_or(None, DEFAULT_HOST), DEFAULT_HOST);
        assert_eq!(override_or(Some(""), DEFAULT_HOST), DEFAULT_HOST);
        assert_eq!(override_or(Some("  "), DEFAULT_HOST), DEFAULT_HOST);
        assert_eq!(
            override_or(Some("https://staging.example.dev"), DEFAULT_HOST),
            "https://staging.example.dev"
        );
    }

    #[test]
    fn an_invalid_override_is_how_a_build_opts_out() {
        assert!(Config::parse(DEFAULT_HOST, "off").is_err());
    }

    #[test]
    fn empty_configuration_disables_analytics() {
        assert!(Config::parse("", "A-SH-abc123").is_err());
        assert!(Config::parse("https://analytics.example.dev", "").is_err());
    }

    #[test]
    fn hosted_aptabase_regions_are_rejected() {
        // Luma only ever talks to its own instance; a build that somehow
        // carried a hosted key must send nothing rather than send it upstream.
        for key in ["A-US-abc123", "A-EU-abc123", "A-DEV-abc123"] {
            assert!(Config::parse("https://analytics.example.dev", key).is_err());
        }
    }

    #[test]
    fn malformed_keys_are_rejected() {
        for key in ["", "A-SH", "A-SH-", "SH-abc123", "A-SH-abc-123", "A-SH-a b"] {
            assert!(Config::parse("https://analytics.example.dev", key).is_err());
        }
    }

    #[test]
    fn malformed_host_disables_instead_of_panicking() {
        // Upstream's plugin does `.parse().unwrap()` here and takes the whole
        // app down on a typo'd host.
        for host in [
            "not a url",
            "ftp://analytics.example.dev",
            "https://user:pass@analytics.example.dev",
            "https://analytics.example.dev?token=1",
            "https://analytics.example.dev#frag",
        ] {
            assert!(Config::parse(host, "A-SH-abc123").is_err(), "{host}");
        }
    }

    #[test]
    fn config_debug_never_leaks_the_host_or_key() {
        let config = Config::parse("https://analytics.example.dev", "A-SH-8606010133").unwrap();
        let debug = format!("{config:?}");
        assert!(!debug.contains("analytics.example.dev"));
        assert!(!debug.contains("8606010133"));
    }
}
