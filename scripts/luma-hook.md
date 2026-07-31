# luma-hook — Luma agent event protocol (v1)

Luma's terminal watches session output for a custom OSC escape sequence that
lets coding agents (Claude Code, Codex, Gemini CLI, OpenCode, anything else)
announce their state. Events surface in Luma's agent inbox with a deep link
back to the owning terminal tab. The protocol is open and versioned; any tool
that can write to the terminal can emit it. Terminals that don't understand
the sequence silently ignore it, and Luma passes the bytes through unchanged.

## Wire format

```
ESC ] 7791 ; luma-agent ; <base64(JSON)> BEL
```

- `ESC ]` starts an OSC sequence; `7791` is Luma's private OSC number.
- Terminator: `BEL` (`\x07`) or `ST` (`ESC \`, `\x1b\x5c`) — both accepted.
- The payload is standard base64 of a UTF-8 JSON object.
- Sequences longer than 8 KiB (base64 portion) are discarded. Keep payloads
  short: `detail` is truncated to 512 characters after decode; other fields
  to 256. Never send transcripts, diffs, or secrets — summaries only.
- Malformed base64/JSON is ignored silently; the terminal is never disturbed.

## JSON payload

```json
{
  "v": 1,
  "sessionId": "the agent's own session id",
  "agent": "claude-code",
  "event": "needs-approval",
  "title": "Approve tool use",
  "detail": "Wants to run: cargo test",
  "ts": 1753800000
}
```

| Field       | Required | Meaning                                                        |
| ----------- | -------- | -------------------------------------------------------------- |
| `v`         | yes      | Protocol version. Must be `1`; other versions are ignored.     |
| `sessionId` | yes      | The agent's own session/conversation id (any non-empty string).|
| `agent`     | yes      | Agent name: `claude-code`, `codex`, `gemini`, `opencode`, or any free-form string. |
| `event`     | yes      | One of the vocabulary below.                                   |
| `title`     | no       | Short human-readable headline.                                 |
| `detail`    | no       | Short summary (≤ 512 chars after decode).                      |
| `ts`        | no       | Unix seconds. Luma falls back to arrival time when absent.     |

### Event vocabulary

| Event               | Meaning                                   | Inbox effect        |
| ------------------- | ----------------------------------------- | ------------------- |
| `needs-approval`    | Agent is blocked on a permission prompt   | attention (unread)  |
| `waiting-for-input` | Agent finished and awaits the human       | attention (unread)  |
| `session-failed`    | Agent aborted with an error               | attention (unread)  |
| `limit-warning`     | Approaching a usage/context limit         | attention (unread)  |
| `tool-started`      | A tool/command began running              | passive update      |
| `tool-finished`     | A tool/command completed                  | passive update      |
| `turn-completed`    | The agent finished a turn                 | passive update      |
| `session-started`   | Agent session began                       | passive update      |
| `session-ended`     | Agent session ended                       | item marked done    |
| `notification`      | Something wants the human's attention     | attention (unread)  |

Unknown event strings are accepted and treated as passive updates, so the
vocabulary can grow without breaking older Luma versions.

## The `luma-hook` script

`scripts/luma-hook` is a dependency-free POSIX sh emitter (needs only
`base64` or `openssl`). It writes the sequence to `/dev/tty` when writable
(so it works from hooks whose stdout is captured), else to stdout.

```sh
luma-hook --agent claude-code --session "$SESSION_ID" \
          --event needs-approval --title "Approve tool use" \
          --detail "Wants to run: cargo test"
```

Install it somewhere on `PATH` (e.g. `cp scripts/luma-hook ~/.local/bin/`).

## Wiring examples

### Claude Code (hooks in `~/.claude/settings.json`)

```json
{
  "hooks": {
    "Notification": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "luma-hook --agent claude-code --session \"${CLAUDE_SESSION_ID:-claude}\" --event needs-approval --title \"Claude Code needs attention\""
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "luma-hook --agent claude-code --session \"${CLAUDE_SESSION_ID:-claude}\" --event waiting-for-input --title \"Claude Code finished a turn\""
          }
        ]
      }
    ]
  }
}
```

(Claude Code also passes hook input as JSON on stdin, including
`session_id`; a wrapper script can extract it for a precise `--session`.)

### Any other agent or script

Emit the sequence from anywhere that writes to the terminal:

```sh
# Long build finished, wake me up:
make -j8; luma-hook --agent build --session "$$" \
    --event waiting-for-input --title "Build finished ($?)"
```

Or emit the raw sequence directly without the script:

```sh
payload='{"v":1,"sessionId":"abc","agent":"my-agent","event":"turn-completed"}'
printf '\033]7791;luma-agent;%s\007' "$(printf '%s' "$payload" | base64 | tr -d '\n')"
```

Works over SSH, mosh, and local shells alike — the sequence just travels the
terminal byte stream.

## Without a hook

An agent running on a remote host can only emit this sequence if `luma-hook` is
installed there, which is not always possible or wanted. Luma therefore also
derives inbox events from what any terminal can already see, with nothing
installed anywhere:

- **Notification sequences** — `OSC 9` (iTerm2), `OSC 777;notify` (urxvt) and
  `OSC 99` (kitty), which agents and long-running commands already emit, plus a
  plain `BEL`. These become `notification` items. A bell that follows a
  keystroke within two seconds is treated as input feedback and ignored.
- **Screen signatures** — Luma matches the rendered screen against a small
  table of agent TUI markers (`apps/desktop/src/features/terminal/agentSignals.ts`)
  shortly after output settles. Watching the busy indicator and the approval
  prompt appear and disappear yields `tool-started`, `needs-approval` and
  `waiting-for-input`. Claude Code is covered today; other agents are added by
  appending a signature.

Both are heuristics: an unrecognised screen produces no event rather than a
guess. Events from the terminal you are currently typing into are still logged
but raise no unread badge — that terminal is already showing you the same thing.
A session that reports even one hook event stops accepting heuristics entirely,
so wiring up `luma-hook` always wins over Luma guessing.
