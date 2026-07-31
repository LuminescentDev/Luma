//! Defensive parsers for the remote listener-discovery script output.
//!
//! The script emits three sections (`ss`, `netstat`, `proctcp`); each parser
//! is a pure function over strings so it can be unit tested with canned
//! fixtures. The first source that yields any listeners wins — `ss` is most
//! informative, `/proc/net/tcp` is the last resort.

use std::collections::HashMap;

use serde::Serialize;

/// Well-known non-HTTP ports we never offer for preview. Deliberately small:
/// anything not obviously wrong stays visible so unusual dev setups still work.
const NON_HTTP_PORTS: &[u16] = &[
    21,    // ftp
    22,    // ssh
    23,    // telnet
    25,    // smtp
    53,    // dns
    111,   // rpcbind
    123,   // ntp
    139,   // netbios
    143,   // imap
    389,   // ldap
    445,   // smb
    465,   // smtps
    587,   // submission
    631,   // cups (ipp)
    636,   // ldaps
    993,   // imaps
    995,   // pop3s
    1433,  // mssql
    2049,  // nfs
    3306,  // mysql
    5432,  // postgres
    5672,  // amqp
    6379,  // redis
    9092,  // kafka
    11211, // memcached
    27017, // mongodb
];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WebListener {
    pub port: u16,
    pub bind_address: String,
    pub pid: Option<u32>,
    pub process: Option<String>,
    /// Friendly classification ("vite", "next", …) or `None` when unknown.
    pub kind: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WebPreviewDiscovery {
    pub listeners: Vec<WebListener>,
}

/// One raw listening socket before dedup/filter/classification.
#[derive(Debug, Clone)]
struct RawListener {
    port: u16,
    bind_address: String,
    pid: Option<u32>,
    process: Option<String>,
}

/// Assembles the discovery result from raw script output. Never fails: a
/// malformed section simply contributes no listeners.
pub(crate) fn parse_discovery(output: &str) -> WebPreviewDiscovery {
    let sections = crate::server_stats::split_sections(output);
    let section = |name: &str| sections.get(name).map(String::as_str).unwrap_or("");
    let raw = [
        parse_ss(section("ss")),
        parse_netstat(section("netstat")),
        parse_proc_tcp(section("proctcp")),
    ]
    .into_iter()
    .find(|listeners| !listeners.is_empty())
    .unwrap_or_default();
    WebPreviewDiscovery {
        listeners: finalize(raw),
    }
}

/// Dedups by port (v4 + v6 wildcard binds show up twice), drops well-known
/// non-HTTP ports, classifies, and sorts by port.
fn finalize(raw: Vec<RawListener>) -> Vec<WebListener> {
    let mut by_port: HashMap<u16, RawListener> = HashMap::new();
    for listener in raw {
        if listener.port == 0 || NON_HTTP_PORTS.contains(&listener.port) {
            continue;
        }
        match by_port.entry(listener.port) {
            std::collections::hash_map::Entry::Vacant(entry) => {
                entry.insert(listener);
            }
            std::collections::hash_map::Entry::Occupied(mut entry) => {
                let current = entry.get_mut();
                // Prefer the row with process info; otherwise prefer the
                // v4/wildcard representation over a bare v6 duplicate.
                if current.process.is_none() && listener.process.is_some() {
                    *current = listener;
                } else if current.bind_address.contains(':') && !listener.bind_address.contains(':')
                {
                    current.bind_address = listener.bind_address;
                }
            }
        }
    }
    let mut listeners = by_port
        .into_values()
        .map(|raw| {
            let kind = classify(raw.process.as_deref(), raw.port);
            WebListener {
                port: raw.port,
                bind_address: raw.bind_address,
                pid: raw.pid,
                process: raw.process,
                kind,
            }
        })
        .collect::<Vec<_>>();
    listeners.sort_by_key(|listener| listener.port);
    listeners
}

/// Process name first, port second, else unknown.
fn classify(process: Option<&str>, port: u16) -> Option<String> {
    if let Some(process) = process {
        let name = process.to_ascii_lowercase();
        let by_process = [
            ("vite", "vite"),
            ("next", "next"),
            ("storybook", "storybook"),
            ("webpack", "webpack"),
            ("python", "python"),
            ("gunicorn", "python"),
            ("uvicorn", "python"),
            ("flask", "python"),
            ("nginx", "nginx"),
            ("caddy", "caddy"),
            ("httpd", "apache"),
            ("apache", "apache"),
            ("php", "php"),
            ("java", "java"),
            ("deno", "deno"),
            ("bun", "bun"),
        ];
        for (needle, kind) in by_process {
            if name.contains(needle) {
                return Some(kind.into());
            }
        }
    }
    let by_port = match port {
        5173 | 5174 => Some("vite"),
        3000 | 3001 => Some("next"),
        6006 => Some("storybook"),
        8080 => Some("webpack"),
        8000 => Some("python"),
        4200 => Some("angular"),
        4321 => Some("astro"),
        8888 => Some("jupyter"),
        80 | 443 | 8443 => Some("http"),
        _ => None,
    };
    by_port.map(String::from)
}

/// `ss -tlnp` output. Process info is optional: without root, `ss` omits the
/// `users:(...)` column for other users' sockets.
fn parse_ss(section: &str) -> Vec<RawListener> {
    section
        .lines()
        .filter_map(|line| {
            let mut columns = line.split_whitespace();
            let state = columns.next()?;
            if !state.eq_ignore_ascii_case("LISTEN") {
                return None;
            }
            // State Recv-Q Send-Q Local:Port Peer:Port [Process]
            let local = columns.nth(2)?;
            let (bind_address, port) = split_address_port(local)?;
            let process_column = columns.nth(1).unwrap_or("");
            let (process, pid) = parse_ss_process(process_column);
            Some(RawListener {
                port,
                bind_address,
                pid,
                process,
            })
        })
        .collect()
}

/// Extracts `("nginx", 123)` from `users:(("nginx",pid=123,fd=6))`.
fn parse_ss_process(column: &str) -> (Option<String>, Option<u32>) {
    let inner = match column.strip_prefix("users:((") {
        Some(inner) => inner,
        None => return (None, None),
    };
    let name = inner
        .strip_prefix('"')
        .and_then(|rest| rest.split('"').next())
        .filter(|name| !name.is_empty())
        .map(String::from);
    let pid = inner
        .split("pid=")
        .nth(1)
        .and_then(|rest| rest.split(|c: char| !c.is_ascii_digit()).next())
        .and_then(|digits| digits.parse().ok());
    (name, pid)
}

/// `netstat -tlnp` output; `PID/Program name` is `-` without privileges.
fn parse_netstat(section: &str) -> Vec<RawListener> {
    section
        .lines()
        .filter_map(|line| {
            let columns = line.split_whitespace().collect::<Vec<_>>();
            let proto = *columns.first()?;
            if !proto.starts_with("tcp") {
                return None;
            }
            if !columns.contains(&"LISTEN") {
                return None;
            }
            let (bind_address, port) = split_address_port(columns.get(3)?)?;
            let (pid, process) = columns
                .get(6)
                .and_then(|column| column.split_once('/'))
                .map(|(pid, name)| (pid.parse().ok(), Some(name.trim().to_string())))
                .unwrap_or((None, None));
            Some(RawListener {
                port,
                bind_address,
                pid,
                process: process.filter(|name| !name.is_empty()),
            })
        })
        .collect()
}

/// Splits `127.0.0.1:5173`, `[::]:80`, `:::80`, `*:8080` into address + port.
fn split_address_port(local: &str) -> Option<(String, u16)> {
    let (address, port) = local.rsplit_once(':')?;
    let port: u16 = port.parse().ok()?;
    let address = address.trim_matches(['[', ']']);
    let bind_address = match address {
        "" | "*" | "0.0.0.0" => "0.0.0.0".to_string(),
        "::" => "::".to_string(),
        other => other.to_string(),
    };
    Some((bind_address, port))
}

/// `/proc/net/tcp` + `/proc/net/tcp6` concatenated. State 0A is LISTEN; the
/// local address is hex `ADDR:PORT` with the address in per-32-bit-word
/// little-endian order. No process info is available from here.
fn parse_proc_tcp(section: &str) -> Vec<RawListener> {
    section
        .lines()
        .filter_map(|line| {
            let mut columns = line.split_whitespace();
            let slot = columns.next()?;
            if !slot.ends_with(':') {
                return None; // header line
            }
            let local = columns.next()?;
            let _remote = columns.next()?;
            let state = columns.next()?;
            if !state.eq_ignore_ascii_case("0A") {
                return None;
            }
            let (address_hex, port_hex) = local.rsplit_once(':')?;
            let port = u16::from_str_radix(port_hex, 16).ok()?;
            let bind_address = parse_proc_address(address_hex)?;
            Some(RawListener {
                port,
                bind_address,
                pid: None,
                process: None,
            })
        })
        .collect()
}

/// Decodes the hex address column: 8 hex chars for IPv4, 32 for IPv6. Each
/// 32-bit word is stored little-endian.
fn parse_proc_address(hex: &str) -> Option<String> {
    match hex.len() {
        8 => {
            let value = u32::from_str_radix(hex, 16).ok()?;
            let octets = value.to_le_bytes();
            Some(std::net::Ipv4Addr::from(octets).to_string())
        }
        32 => {
            let mut bytes = [0u8; 16];
            for (word_index, chunk) in hex.as_bytes().chunks(8).enumerate() {
                let chunk = std::str::from_utf8(chunk).ok()?;
                let word = u32::from_str_radix(chunk, 16).ok()?;
                bytes[word_index * 4..word_index * 4 + 4].copy_from_slice(&word.to_le_bytes());
            }
            Some(std::net::Ipv6Addr::from(bytes).to_string())
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn discovery(output: &str) -> Vec<WebListener> {
        parse_discovery(output).listeners
    }

    #[test]
    fn parses_ss_with_process_info() {
        let output = "===LUMA:ss===\n\
            State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process\n\
            LISTEN 0      511    127.0.0.1:5173     0.0.0.0:*         users:((\"node\",pid=4242,fd=20))\n\
            LISTEN 0      511    0.0.0.0:8080       0.0.0.0:*         users:((\"webpack\",pid=99,fd=3))\n";
        let listeners = discovery(output);
        assert_eq!(listeners.len(), 2);
        assert_eq!(listeners[0].port, 5173);
        assert_eq!(listeners[0].bind_address, "127.0.0.1");
        assert_eq!(listeners[0].pid, Some(4242));
        assert_eq!(listeners[0].process.as_deref(), Some("node"));
        assert_eq!(listeners[0].kind.as_deref(), Some("vite"));
        assert_eq!(listeners[1].process.as_deref(), Some("webpack"));
        assert_eq!(listeners[1].kind.as_deref(), Some("webpack"));
    }

    #[test]
    fn parses_ss_without_process_info() {
        // Non-root ss omits the process column for other users' sockets.
        let output = "===LUMA:ss===\n\
            LISTEN 0 128 0.0.0.0:3000 0.0.0.0:*\n\
            LISTEN 0 128 [::]:3000    [::]:*\n";
        let listeners = discovery(output);
        assert_eq!(listeners.len(), 1);
        assert_eq!(listeners[0].port, 3000);
        assert_eq!(listeners[0].bind_address, "0.0.0.0");
        assert_eq!(listeners[0].pid, None);
        assert_eq!(listeners[0].process, None);
        assert_eq!(listeners[0].kind.as_deref(), Some("next"));
    }

    #[test]
    fn dedups_v4_and_v6_preferring_process_info() {
        let output = "===LUMA:ss===\n\
            LISTEN 0 128 [::]:6006    [::]:*\n\
            LISTEN 0 128 0.0.0.0:6006 0.0.0.0:* users:((\"storybook\",pid=7,fd=1))\n";
        let listeners = discovery(output);
        assert_eq!(listeners.len(), 1);
        assert_eq!(listeners[0].bind_address, "0.0.0.0");
        assert_eq!(listeners[0].pid, Some(7));
        assert_eq!(listeners[0].kind.as_deref(), Some("storybook"));
    }

    #[test]
    fn filters_non_http_ports() {
        let output = "===LUMA:ss===\n\
            LISTEN 0 128 0.0.0.0:22   0.0.0.0:*\n\
            LISTEN 0 128 127.0.0.1:5432 0.0.0.0:*\n\
            LISTEN 0 128 127.0.0.1:6379 0.0.0.0:*\n\
            LISTEN 0 128 0.0.0.0:8000 0.0.0.0:* users:((\"python3\",pid=11,fd=5))\n";
        let listeners = discovery(output);
        assert_eq!(listeners.len(), 1);
        assert_eq!(listeners[0].port, 8000);
        assert_eq!(listeners[0].kind.as_deref(), Some("python"));
    }

    #[test]
    fn falls_back_to_netstat_when_ss_is_empty() {
        let output = "===LUMA:ss===\n\
            ===LUMA:netstat===\n\
            Proto Recv-Q Send-Q Local Address Foreign Address State PID/Program name\n\
            tcp   0      0      0.0.0.0:8081  0.0.0.0:*       LISTEN 1234/node\n\
            tcp6  0      0      :::9090       :::*            LISTEN -\n\
            udp   0      0      0.0.0.0:68    0.0.0.0:*                  -\n";
        let listeners = discovery(output);
        assert_eq!(listeners.len(), 2);
        assert_eq!(listeners[0].port, 8081);
        assert_eq!(listeners[0].pid, Some(1234));
        assert_eq!(listeners[0].process.as_deref(), Some("node"));
        assert_eq!(listeners[1].port, 9090);
        assert_eq!(listeners[1].bind_address, "::");
        assert_eq!(listeners[1].process, None);
    }

    #[test]
    fn falls_back_to_proc_net_tcp_hex_parsing() {
        // 0100007F = 127.0.0.1 (little-endian words), 1F90 = 8080; 0BB8 = 3000.
        let output = "===LUMA:ss===\n\
            ===LUMA:netstat===\n\
            ===LUMA:proctcp===\n\
            \x20 sl  local_address rem_address   st tx_queue rx_queue\n\
            \x20  0: 0100007F:1F90 00000000:0000 0A 00000000:00000000\n\
            \x20  1: 00000000:0BB8 00000000:0000 0A 00000000:00000000\n\
            \x20  2: 0100007F:1F90 00000000:0000 01 00000000:00000000\n\
            \x20  0: 00000000000000000000000001000000:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000\n";
        let listeners = discovery(output);
        assert_eq!(listeners.len(), 2);
        assert_eq!(listeners[0].port, 3000);
        assert_eq!(listeners[0].bind_address, "0.0.0.0");
        assert_eq!(listeners[1].port, 8080);
        assert_eq!(listeners[1].bind_address, "127.0.0.1");
        // Established (state 01) socket on 8080 was ignored, loopback v6 deduped.
    }

    #[test]
    fn proc_v6_loopback_and_wildcard_decode() {
        assert_eq!(
            parse_proc_address("00000000000000000000000001000000").as_deref(),
            Some("::1")
        );
        assert_eq!(
            parse_proc_address("00000000000000000000000000000000").as_deref(),
            Some("::")
        );
        assert_eq!(parse_proc_address("0100007F").as_deref(), Some("127.0.0.1"));
        assert_eq!(parse_proc_address("xyz"), None);
    }

    #[test]
    fn empty_output_yields_no_listeners() {
        assert!(discovery("").is_empty());
        assert!(discovery("===LUMA:ss===\ngarbage here\n").is_empty());
    }

    #[test]
    fn classification_prefers_process_over_port() {
        assert_eq!(classify(Some("vite"), 3000).as_deref(), Some("vite"));
        assert_eq!(classify(Some("next-server"), 5173).as_deref(), Some("next"));
        assert_eq!(classify(None, 5173).as_deref(), Some("vite"));
        assert_eq!(classify(Some("mystery"), 12345), None);
        assert_eq!(classify(None, 12345), None);
    }
}
