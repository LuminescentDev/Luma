use serde::Serialize;

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
}
