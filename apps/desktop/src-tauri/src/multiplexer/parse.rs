//! Defensive parsers for the remote multiplexer-discovery script output.
//!
//! The script emits four sections (`avail`, `tmuxsessions`, `tmuxwindows`,
//! `zellij`). Every parser here is a pure function over strings so it can be
//! unit tested with canned fixtures — nothing in this file talks to SSH.
//!
//! Both multiplexers allow spaces in session names, so tmux rows are split on
//! the TAB the script injects between fields (never on whitespace), and zellij
//! rows are cut at the ` [Created …]` marker rather than at the first space.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// Longest session name we will surface (and, later, attach to).
pub(crate) const MAX_SESSION_NAME_LENGTH: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MultiplexerKind {
    Tmux,
    Zellij,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MultiplexerWindow {
    pub index: u32,
    pub name: String,
    pub panes: u32,
    pub active: bool,
}

/// One discovered workspace. `windows` is only populated for tmux, and only
/// when the window listing actually covered that session; `windowCount` is the
/// cheap fallback the session listing always provides.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MultiplexerSession {
    pub kind: MultiplexerKind,
    pub name: String,
    pub windows: Option<Vec<MultiplexerWindow>>,
    pub window_count: Option<u32>,
    pub attached: bool,
    /// Unix seconds of last activity (tmux only).
    pub activity_ts: Option<i64>,
    /// Unix seconds the session was created (tmux only).
    pub created_ts: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MultiplexerDiscovery {
    pub tmux_available: bool,
    pub zellij_available: bool,
    pub sessions: Vec<MultiplexerSession>,
}

/// Assembles the discovery result from raw script output. Never fails: a
/// malformed or missing section simply contributes nothing.
pub(crate) fn parse_discovery(output: &str) -> MultiplexerDiscovery {
    let sections = crate::server_stats::split_sections(output);
    let section = |name: &str| sections.get(name).map(String::as_str).unwrap_or("");
    let available = section("avail");
    let mut sessions = parse_tmux(section("tmuxsessions"), section("tmuxwindows"));
    sessions.extend(parse_zellij(section("zellij")));
    MultiplexerDiscovery {
        tmux_available: available.lines().any(|line| line.trim() == "tmux"),
        zellij_available: available.lines().any(|line| line.trim() == "zellij"),
        sessions,
    }
}

/// A name we are willing to show. Deliberately looser than the attach-time
/// validation (which additionally rejects shell metacharacters): discovery
/// stays informative, and an unattachable name fails loudly at attach time.
fn plausible_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().count() <= MAX_SESSION_NAME_LENGTH
        && !name.chars().any(char::is_control)
}

/// `tmux list-sessions` + `tmux list-windows -a`, both TAB-delimited.
///
/// Sessions are the source of truth: a session with no rows in the window
/// listing keeps `windows: None` (the count from the session row still shows).
fn parse_tmux(sessions_section: &str, windows_section: &str) -> Vec<MultiplexerSession> {
    let mut windows_by_session: HashMap<String, Vec<MultiplexerWindow>> = HashMap::new();
    for line in windows_section.lines() {
        let fields = split_fields(line);
        if fields.len() < 5 {
            continue;
        }
        let Ok(index) = fields[1].trim().parse::<u32>() else {
            continue;
        };
        windows_by_session
            .entry(fields[0].to_string())
            .or_default()
            .push(MultiplexerWindow {
                index,
                name: fields[2].to_string(),
                panes: fields[3].trim().parse::<u32>().unwrap_or(1),
                active: fields[4].trim() == "1",
            });
    }
    for windows in windows_by_session.values_mut() {
        windows.sort_by_key(|window| window.index);
    }

    sessions_section
        .lines()
        .filter_map(|line| {
            let fields = split_fields(line);
            // name + window count + attached flag is the minimum that proves
            // this is a format row rather than stray output.
            if fields.len() < 3 {
                return None;
            }
            let name = fields[0];
            if !plausible_name(name) {
                return None;
            }
            let window_count = fields[1].trim().parse::<u32>().ok()?;
            Some(MultiplexerSession {
                kind: MultiplexerKind::Tmux,
                name: name.to_string(),
                windows: windows_by_session.remove(name),
                window_count: Some(window_count),
                attached: fields[2].trim() != "0",
                activity_ts: fields.get(3).and_then(|value| value.trim().parse().ok()),
                created_ts: fields.get(4).and_then(|value| value.trim().parse().ok()),
            })
        })
        .collect()
}

/// TAB-delimited fields of one row, with any CR from a CRLF host stripped.
fn split_fields(line: &str) -> Vec<&str> {
    line.trim_end_matches('\r').split('\t').collect()
}

/// `zellij list-sessions`. Newer releases print
/// `name [Created 3m 4s ago] (ATTACHED)` (with color unless `--no-formatting`),
/// older ones print bare names, one per line. Exited-but-resurrectable sessions
/// are kept: `zellij attach` brings them back, which is the whole point of the
/// resume flow.
fn parse_zellij(section: &str) -> Vec<MultiplexerSession> {
    section
        .lines()
        .filter_map(|line| {
            let line = strip_ansi(line);
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            let lowercase = line.to_ascii_lowercase();
            if lowercase.starts_with("no active") || lowercase.contains("sessions found") {
                return None;
            }
            let name = match line.find(" [") {
                Some(index) => line[..index].trim(),
                // Bare format: a session name is one token, so a line with
                // spaces and no `[Created …]` marker is noise.
                None if !line.contains(char::is_whitespace) => line,
                None => return None,
            };
            if !plausible_name(name) {
                return None;
            }
            Some(MultiplexerSession {
                kind: MultiplexerKind::Zellij,
                name: name.to_string(),
                windows: None,
                window_count: None,
                // zellij reports a relative age, never a timestamp, so there is
                // nothing meaningful to put in activityTs/createdTs.
                attached: line.contains("(ATTACHED)"),
                activity_ts: None,
                created_ts: None,
            })
        })
        .collect()
}

/// Drops CSI/escape sequences so colored `zellij list-sessions` output (older
/// releases have no `--no-formatting`) parses like the plain form.
fn strip_ansi(line: &str) -> String {
    let mut output = String::with_capacity(line.len());
    let mut characters = line.chars();
    while let Some(character) = characters.next() {
        if character != '\u{1b}' {
            output.push(character);
            continue;
        }
        // CSI (`ESC [`) runs until its final byte (@..~); any other escape is
        // two bytes, so consuming the one that follows ESC is enough.
        if characters.next() == Some('[') {
            for escaped in characters.by_ref() {
                if ('\u{40}'..='\u{7e}').contains(&escaped) {
                    break;
                }
            }
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmux_line(fields: &[&str]) -> String {
        fields.join("\t")
    }

    #[test]
    fn parses_tmux_sessions_with_windows() {
        let output = format!(
            "===LUMA:avail===\ntmux\n===LUMA:tmuxsessions===\n{}\n{}\n===LUMA:tmuxwindows===\n{}\n{}\n{}\n",
            tmux_line(&["main", "3", "1", "1700000000", "1699000000"]),
            tmux_line(&["my project", "1", "0", "1700000500", "1699000500"]),
            tmux_line(&["main", "1", "editor", "2", "0"]),
            tmux_line(&["main", "0", "shell", "1", "1"]),
            tmux_line(&["my project", "0", "build logs", "3", "1"]),
        );
        let discovery = parse_discovery(&output);
        assert!(discovery.tmux_available);
        assert!(!discovery.zellij_available);
        assert_eq!(discovery.sessions.len(), 2);

        let main = &discovery.sessions[0];
        assert_eq!(main.kind, MultiplexerKind::Tmux);
        assert_eq!(main.name, "main");
        assert!(main.attached);
        assert_eq!(main.window_count, Some(3));
        assert_eq!(main.activity_ts, Some(1_700_000_000));
        assert_eq!(main.created_ts, Some(1_699_000_000));
        let windows = main.windows.as_ref().unwrap();
        // Sorted by window index, not by listing order.
        assert_eq!(windows[0].index, 0);
        assert_eq!(windows[0].name, "shell");
        assert!(windows[0].active);
        assert_eq!(windows[1].index, 1);
        assert_eq!(windows[1].name, "editor");
        assert_eq!(windows[1].panes, 2);
        assert!(!windows[1].active);

        // Names with spaces survive on both sides of the join.
        let project = &discovery.sessions[1];
        assert_eq!(project.name, "my project");
        assert!(!project.attached);
        assert_eq!(
            project.windows.as_ref().unwrap()[0].name,
            "build logs".to_string()
        );
    }

    #[test]
    fn tmux_session_without_listed_windows_keeps_only_its_count() {
        let output = format!(
            "===LUMA:tmuxsessions===\n{}\n===LUMA:tmuxwindows===\n",
            tmux_line(&["solo", "2", "0", "1700000000", "1699000000"]),
        );
        let session = &parse_discovery(&output).sessions[0];
        assert_eq!(session.windows, None);
        assert_eq!(session.window_count, Some(2));
    }

    #[test]
    fn tmux_rows_missing_optional_timestamps_still_parse() {
        let output = format!(
            "===LUMA:tmuxsessions===\n{}\n",
            tmux_line(&["old", "1", "0"]),
        );
        let session = &parse_discovery(&output).sessions[0];
        assert_eq!(session.name, "old");
        assert_eq!(session.window_count, Some(1));
        assert_eq!(session.activity_ts, None);
        assert_eq!(session.created_ts, None);
    }

    #[test]
    fn tmux_garbage_lines_are_ignored() {
        // "no server running on …" goes to stderr (silenced), but anything that
        // does reach stdout must not become a session.
        let output = "===LUMA:tmuxsessions===\n\
            no server running on /tmp/tmux-1000/default\n\
            \n\
            not\ta\tnumber\n\
            ===LUMA:tmuxwindows===\nrubbish\n";
        assert!(parse_discovery(output).sessions.is_empty());
    }

    #[test]
    fn tmux_names_are_not_split_on_spaces() {
        let output = format!(
            "===LUMA:tmuxsessions===\n{}\n",
            tmux_line(&["a b c d e", "4", "1", "1700000000", "1699000000"]),
        );
        let sessions = parse_discovery(&output).sessions;
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].name, "a b c d e");
        assert_eq!(sessions[0].window_count, Some(4));
    }

    #[test]
    fn parses_zellij_new_format_with_markers() {
        let output = "===LUMA:avail===\nzellij\n===LUMA:zellij===\n\
            dashing-cat [Created 2h 3m 5s ago] (ATTACHED)\n\
            quiet-owl [Created 1m 2s ago]\n\
            gone-fish [Created 5m ago] (EXITED - attach to resurrect)\n";
        let discovery = parse_discovery(output);
        assert!(discovery.zellij_available);
        assert!(!discovery.tmux_available);
        assert_eq!(discovery.sessions.len(), 3);
        assert!(discovery
            .sessions
            .iter()
            .all(|session| session.kind == MultiplexerKind::Zellij));
        assert_eq!(discovery.sessions[0].name, "dashing-cat");
        assert!(discovery.sessions[0].attached);
        assert_eq!(discovery.sessions[1].name, "quiet-owl");
        assert!(!discovery.sessions[1].attached);
        // Exited sessions stay listed: attaching resurrects them.
        assert_eq!(discovery.sessions[2].name, "gone-fish");
        assert!(!discovery.sessions[2].attached);
        assert_eq!(discovery.sessions[0].windows, None);
        assert_eq!(discovery.sessions[0].window_count, None);
    }

    #[test]
    fn parses_zellij_bare_and_colored_output() {
        let output = "===LUMA:zellij===\n\
            plain-name\n\
            \u{1b}[32mcolored-name\u{1b}[0m [Created 4s ago] (ATTACHED)\n\
            No active zellij sessions found.\n\
            this line is clearly not a session name\n";
        let sessions = parse_discovery(output).sessions;
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].name, "plain-name");
        assert_eq!(sessions[1].name, "colored-name");
        assert!(sessions[1].attached);
    }

    #[test]
    fn zellij_keeps_names_containing_spaces_when_marked() {
        let output = "===LUMA:zellij===\nmy work [Created 1s ago]\n";
        let sessions = parse_discovery(output).sessions;
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].name, "my work");
    }

    #[test]
    fn empty_output_yields_nothing_available() {
        for output in ["", "===LUMA:avail===\n===LUMA:tmuxsessions===\n"] {
            let discovery = parse_discovery(output);
            assert!(!discovery.tmux_available);
            assert!(!discovery.zellij_available);
            assert!(discovery.sessions.is_empty());
        }
    }

    #[test]
    fn availability_is_independent_of_sessions() {
        let output = "===LUMA:avail===\ntmux\nzellij\n===LUMA:tmuxsessions===\n";
        let discovery = parse_discovery(output);
        assert!(discovery.tmux_available);
        assert!(discovery.zellij_available);
        assert!(discovery.sessions.is_empty());
    }

    #[test]
    fn control_characters_and_overlong_names_are_dropped() {
        let long = "x".repeat(MAX_SESSION_NAME_LENGTH + 1);
        let output = format!(
            "===LUMA:tmuxsessions===\n{}\n{}\n===LUMA:zellij===\n{}\n",
            tmux_line(&["bad\u{7}name", "1", "0"]),
            tmux_line(&[long.as_str(), "1", "0"]),
            long,
        );
        assert!(parse_discovery(&output).sessions.is_empty());
    }

    #[test]
    fn strips_ansi_sequences() {
        assert_eq!(strip_ansi("\u{1b}[1;32mgreen\u{1b}[0m"), "green");
        assert_eq!(strip_ansi("plain"), "plain");
    }
}
