//! Agent-aware terminal events.
//!
//! Coding agents (Claude Code, Codex, ...) announce their state by writing a
//! custom OSC sequence into the terminal stream:
//!
//! `ESC ] 7791 ; luma-agent ; <base64(JSON)> BEL`  (also accepts `ESC \` (ST))
//!
//! The JSON payload is versioned (`v: 1`) and carries short summaries only —
//! never transcripts or diffs. The scanner watches session output for these
//! sequences and reports parsed events; the byte stream itself is passed
//! through UNCHANGED (xterm.js ignores unknown OSC sequences), so scanning can
//! never corrupt terminal output. Sequences split across read chunks are
//! handled by keeping the scanner state across calls, bounded at 8 KiB per
//! sequence; anything malformed is silently ignored.

use std::sync::{Arc, Mutex};

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime};

/// Tauri event name delivered to the "main" window for each parsed agent event.
pub const AGENT_EVENT_NAME: &str = "agent-event";

/// `ESC ] 7791 ; luma-agent ;`
const OSC_PREFIX: &[u8] = b"\x1b]7791;luma-agent;";
/// Maximum base64 payload length; longer sequences are discarded.
const MAX_SEQUENCE_BYTES: usize = 8 * 1024;
/// Detail is a short summary; anything longer is truncated after decode.
const MAX_DETAIL_CHARS: usize = 512;
/// Titles and identifier-ish fields get a smaller defensive cap.
const MAX_FIELD_CHARS: usize = 256;
/// Events observed before the Luma session id is known are buffered (spawn
/// returns quickly, so this only covers a tiny startup window).
const MAX_PENDING_EVENTS: usize = 16;

/// Wire payload as emitted by agents (decoded from base64 JSON).
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct AgentWireEvent {
    pub v: u32,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub agent: String,
    pub event: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub detail: Option<String>,
    #[serde(default)]
    pub ts: Option<i64>,
}

/// Event payload emitted to the frontend: the wire event plus the Luma
/// terminal session id that produced it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEvent {
    pub terminal_session_id: String,
    pub agent_session_id: String,
    pub agent: String,
    pub event: String,
    pub title: Option<String>,
    pub detail: Option<String>,
    pub ts: Option<i64>,
}

enum ScanState {
    /// Looking for the start of the OSC prefix.
    Idle,
    /// Matched `n` bytes of the prefix so far.
    Prefix(usize),
    /// Inside the payload, collecting base64 bytes until BEL or ST.
    Payload(Vec<u8>),
    /// Saw ESC inside the payload; a following `\` (ST) terminates it.
    PayloadEsc(Vec<u8>),
}

/// Incremental scanner for agent OSC sequences. Feed it every output chunk of
/// a session; it keeps at most one partial sequence (bounded) across calls.
pub struct AgentEventScanner {
    state: ScanState,
}

impl Default for AgentEventScanner {
    fn default() -> Self {
        Self {
            state: ScanState::Idle,
        }
    }
}

impl AgentEventScanner {
    pub fn new() -> Self {
        Self::default()
    }

    /// Scan a chunk of terminal output, returning any complete, valid agent
    /// events found. The chunk itself must still be forwarded unchanged.
    pub fn scan(&mut self, chunk: &[u8]) -> Vec<AgentWireEvent> {
        let mut events = Vec::new();
        for &byte in chunk {
            self.step(byte, &mut events);
        }
        events
    }

    fn step(&mut self, byte: u8, events: &mut Vec<AgentWireEvent>) {
        let state = std::mem::replace(&mut self.state, ScanState::Idle);
        self.state = match state {
            ScanState::Idle => {
                if byte == OSC_PREFIX[0] {
                    ScanState::Prefix(1)
                } else {
                    ScanState::Idle
                }
            }
            ScanState::Prefix(matched) => {
                if byte == OSC_PREFIX[matched] {
                    if matched + 1 == OSC_PREFIX.len() {
                        ScanState::Payload(Vec::new())
                    } else {
                        ScanState::Prefix(matched + 1)
                    }
                } else if byte == OSC_PREFIX[0] {
                    // ESC restarts a potential sequence.
                    ScanState::Prefix(1)
                } else {
                    ScanState::Idle
                }
            }
            ScanState::Payload(mut payload) => {
                if byte == 0x07 {
                    // BEL terminator.
                    if let Some(event) = parse_payload(&payload) {
                        events.push(event);
                    }
                    ScanState::Idle
                } else if byte == 0x1b {
                    ScanState::PayloadEsc(payload)
                } else if payload.len() >= MAX_SEQUENCE_BYTES {
                    // Oversized: discard the whole sequence.
                    ScanState::Idle
                } else {
                    payload.push(byte);
                    ScanState::Payload(payload)
                }
            }
            ScanState::PayloadEsc(payload) => {
                if byte == b'\\' {
                    // ST terminator.
                    if let Some(event) = parse_payload(&payload) {
                        events.push(event);
                    }
                    ScanState::Idle
                } else {
                    // A bare ESC cannot appear in base64: abort this sequence.
                    // The consumed ESC may itself start a new sequence, so
                    // resume as if it was just seen and re-examine this byte.
                    self.state = ScanState::Prefix(1);
                    self.step(byte, events);
                    return;
                }
            }
        };
    }
}

/// Decode and validate a captured payload. Any failure → `None` (silently
/// ignored: agents may be buggy, the terminal must not care).
fn parse_payload(payload: &[u8]) -> Option<AgentWireEvent> {
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .ok()?;
    let mut event: AgentWireEvent = serde_json::from_slice(&decoded).ok()?;
    if event.v != 1 {
        return None;
    }
    if event.session_id.is_empty() || event.agent.is_empty() || event.event.is_empty() {
        return None;
    }
    truncate_chars(&mut event.session_id, MAX_FIELD_CHARS);
    truncate_chars(&mut event.agent, MAX_FIELD_CHARS);
    truncate_chars(&mut event.event, MAX_FIELD_CHARS);
    if let Some(title) = event.title.as_mut() {
        truncate_chars(title, MAX_FIELD_CHARS);
    }
    if let Some(detail) = event.detail.as_mut() {
        truncate_chars(detail, MAX_DETAIL_CHARS);
    }
    Some(event)
}

fn truncate_chars(value: &mut String, max_chars: usize) {
    if let Some((index, _)) = value.char_indices().nth(max_chars) {
        value.truncate(index);
    }
}

struct SinkState {
    terminal_session_id: Option<String>,
    pending: Vec<AgentWireEvent>,
}

/// Bridges a session's scanner to the frontend. Created before spawn (the
/// data callback needs it), attached to the Luma session id once spawn
/// returns; events seen in between are buffered.
pub struct AgentEventSink<R: Runtime> {
    app: AppHandle<R>,
    state: Arc<Mutex<SinkState>>,
}

impl<R: Runtime> Clone for AgentEventSink<R> {
    fn clone(&self) -> Self {
        Self {
            app: self.app.clone(),
            state: Arc::clone(&self.state),
        }
    }
}

impl<R: Runtime> AgentEventSink<R> {
    pub fn new(app: AppHandle<R>) -> Self {
        Self {
            app,
            state: Arc::new(Mutex::new(SinkState {
                terminal_session_id: None,
                pending: Vec::new(),
            })),
        }
    }

    /// Record the Luma terminal session id and flush any buffered events.
    pub fn attach(&self, terminal_session_id: &str) {
        let pending = {
            let mut state = self.state.lock().unwrap();
            state.terminal_session_id = Some(terminal_session_id.to_string());
            std::mem::take(&mut state.pending)
        };
        for event in pending {
            self.emit(terminal_session_id, event);
        }
    }

    /// Handle events produced by the scanner for this session.
    pub fn publish(&self, events: Vec<AgentWireEvent>) {
        if events.is_empty() {
            return;
        }
        let session_id = {
            let mut state = self.state.lock().unwrap();
            match &state.terminal_session_id {
                Some(id) => id.clone(),
                None => {
                    for event in events {
                        if state.pending.len() < MAX_PENDING_EVENTS {
                            state.pending.push(event);
                        }
                    }
                    return;
                }
            }
        };
        for event in events {
            self.emit(&session_id, event);
        }
    }

    fn emit(&self, terminal_session_id: &str, event: AgentWireEvent) {
        let payload = AgentEvent {
            terminal_session_id: terminal_session_id.to_string(),
            agent_session_id: event.session_id,
            agent: event.agent,
            event: event.event,
            title: event.title,
            detail: event.detail,
            ts: event.ts,
        };
        // Broadcast rather than target "main": the label is only implied by the
        // window config, and the mobile shell listens from whatever window the
        // platform gave it. Every listener is in-process, so there is nothing
        // to leak by not naming one.
        let _ = self.app.emit(AGENT_EVENT_NAME, payload);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode(json: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(json)
    }

    fn sample_json() -> String {
        r#"{"v":1,"sessionId":"agent-1","agent":"claude-code","event":"needs-approval","title":"Approve tool use","detail":"Wants to run cargo test","ts":1753800000}"#.to_string()
    }

    fn sequence_bel(json: &str) -> Vec<u8> {
        let mut seq = OSC_PREFIX.to_vec();
        seq.extend_from_slice(encode(json).as_bytes());
        seq.push(0x07);
        seq
    }

    fn sequence_st(json: &str) -> Vec<u8> {
        let mut seq = OSC_PREFIX.to_vec();
        seq.extend_from_slice(encode(json).as_bytes());
        seq.extend_from_slice(b"\x1b\\");
        seq
    }

    #[test]
    fn parses_event_in_single_chunk_with_bel() {
        let mut scanner = AgentEventScanner::new();
        let events = scanner.scan(&sequence_bel(&sample_json()));
        assert_eq!(events.len(), 1);
        let event = &events[0];
        assert_eq!(event.v, 1);
        assert_eq!(event.session_id, "agent-1");
        assert_eq!(event.agent, "claude-code");
        assert_eq!(event.event, "needs-approval");
        assert_eq!(event.title.as_deref(), Some("Approve tool use"));
        assert_eq!(event.detail.as_deref(), Some("Wants to run cargo test"));
        assert_eq!(event.ts, Some(1753800000));
    }

    #[test]
    fn parses_event_with_st_terminator() {
        let mut scanner = AgentEventScanner::new();
        let events = scanner.scan(&sequence_st(&sample_json()));
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event, "needs-approval");
    }

    #[test]
    fn parses_event_split_across_chunks() {
        let sequence = sequence_bel(&sample_json());
        // Split at every possible boundary, including inside the prefix and
        // inside the two-byte ST-less terminator.
        for split in 1..sequence.len() {
            let mut scanner = AgentEventScanner::new();
            let mut events = scanner.scan(&sequence[..split]);
            events.extend(scanner.scan(&sequence[split..]));
            assert_eq!(events.len(), 1, "failed at split {split}");
            assert_eq!(events[0].session_id, "agent-1");
        }
    }

    #[test]
    fn st_terminator_split_between_esc_and_backslash() {
        let sequence = sequence_st(&sample_json());
        let split = sequence.len() - 1; // between ESC and `\`
        let mut scanner = AgentEventScanner::new();
        let mut events = scanner.scan(&sequence[..split]);
        events.extend(scanner.scan(&sequence[split..]));
        assert_eq!(events.len(), 1);
    }

    #[test]
    fn extracts_event_interleaved_with_terminal_noise() {
        let mut stream = b"\x1b[31mred text\x1b[0m $ ls -la\r\n".to_vec();
        stream.extend_from_slice(&sequence_bel(&sample_json()));
        stream.extend_from_slice(b"\x1b]0;window title\x07more output\r\n");
        let mut scanner = AgentEventScanner::new();
        let events = scanner.scan(&stream);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].agent, "claude-code");
    }

    #[test]
    fn two_events_in_one_chunk() {
        let mut stream = sequence_bel(&sample_json());
        stream.extend_from_slice(b"in between");
        stream.extend_from_slice(&sequence_st(
            r#"{"v":1,"sessionId":"agent-2","agent":"codex","event":"turn-completed"}"#,
        ));
        let mut scanner = AgentEventScanner::new();
        let events = scanner.scan(&stream);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].session_id, "agent-1");
        assert_eq!(events[1].session_id, "agent-2");
        assert_eq!(events[1].event, "turn-completed");
    }

    #[test]
    fn oversized_sequence_is_discarded() {
        let mut seq = OSC_PREFIX.to_vec();
        seq.extend(std::iter::repeat_n(b'A', MAX_SEQUENCE_BYTES + 64));
        seq.push(0x07);
        // A valid event right after must still parse.
        seq.extend_from_slice(&sequence_bel(&sample_json()));
        let mut scanner = AgentEventScanner::new();
        let events = scanner.scan(&seq);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].session_id, "agent-1");
    }

    #[test]
    fn garbage_base64_is_ignored() {
        let mut seq = OSC_PREFIX.to_vec();
        seq.extend_from_slice(b"!!!not-base64!!!");
        seq.push(0x07);
        let mut scanner = AgentEventScanner::new();
        assert!(scanner.scan(&seq).is_empty());
    }

    #[test]
    fn valid_base64_invalid_json_is_ignored() {
        let mut seq = OSC_PREFIX.to_vec();
        seq.extend_from_slice(encode("this is not json").as_bytes());
        seq.push(0x07);
        let mut scanner = AgentEventScanner::new();
        assert!(scanner.scan(&seq).is_empty());
    }

    #[test]
    fn unknown_version_is_ignored() {
        let mut scanner = AgentEventScanner::new();
        let events = scanner.scan(&sequence_bel(
            r#"{"v":2,"sessionId":"s","agent":"a","event":"e"}"#,
        ));
        assert!(events.is_empty());
    }

    #[test]
    fn missing_required_fields_are_ignored() {
        let mut scanner = AgentEventScanner::new();
        assert!(scanner
            .scan(&sequence_bel(
                r#"{"v":1,"sessionId":"","agent":"a","event":"e"}"#
            ))
            .is_empty());
        assert!(scanner
            .scan(&sequence_bel(r#"{"v":1,"agent":"a","event":"e"}"#))
            .is_empty());
    }

    #[test]
    fn long_detail_is_truncated_after_decode() {
        let detail = "d".repeat(2000);
        let json = format!(
            r#"{{"v":1,"sessionId":"s","agent":"a","event":"tool-started","detail":"{detail}"}}"#
        );
        let mut scanner = AgentEventScanner::new();
        let events = scanner.scan(&sequence_bel(&json));
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].detail.as_ref().unwrap().chars().count(), 512);
    }

    #[test]
    fn esc_inside_payload_aborts_and_rescans() {
        // An aborted sequence followed by a fresh valid one.
        let mut stream = OSC_PREFIX.to_vec();
        stream.extend_from_slice(b"partial");
        stream.extend_from_slice(&sequence_bel(&sample_json())); // starts with ESC
        let mut scanner = AgentEventScanner::new();
        let events = scanner.scan(&stream);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].session_id, "agent-1");
    }
}
