# Luma

A lightweight, cross-platform terminal and SSH client for Windows, macOS, and
Linux, built with Tauri instead of Electron.

Luma combines local and serial terminals, saved SSH connections, SFTP, and
encrypted configuration sync in a modern desktop interface. It requires no
Luma account or paid cloud service.

> **Status: early development.** Most core workflows are implemented, but the
> project has not reached a stable release. Expect rough edges and breaking
> changes.

## Features

### Terminals

- Local terminals backed by native PTYs and rendered with xterm.js
- Automatic shell discovery plus configurable shell profiles, working
  directories, and environment variables
- Tabs and horizontal or vertical split panes
- Terminal search, clickable links, configurable scrollback, and WebGL
  rendering where available
- Serial terminals with selectable port and baud rate
- Optional workspace persistence and restoration

### SSH and host management

- Saved hosts, groups, favorites, tags, search, and recent connections
- System OpenSSH integration with agent, password, interactive, and private-key
  authentication
- Encrypted and passphrase-protected private keys, public-key derivation, and
  SSH certificates
- ProxyJump, agent forwarding, keepalive, startup commands, working
  directories, and per-host environment variables
- Explicit unknown-host confirmation and changed-host-key warnings
- Import from OpenSSH config and Termius vault exports
- Parsed connection errors with reconnect support

### SFTP and productivity

- Dual-pane local/remote SFTP browser
- Create, rename, and delete files and directories
- File and directory upload and download, including drag-and-drop between panes,
  with per-file and whole-folder aggregate progress, cancellation, and retry
- Recursive directory transfers that report skipped symlinks and per-entry
  failures, with retry limited to the failed or incomplete entries
- Saved snippets with a parameterized snippet runner
- Local and remote port forwarding
- Searchable command palette

### Security, backup, and updates

- SQLite-backed settings and metadata with versioned migrations
- Private keys and passphrases encrypted with Argon2id and
  XChaCha20-Poly1305
- Optional OS keychain storage through Windows Credential Manager, macOS
  Keychain, or Linux Secret Service
- End-to-end-encrypted sync through a local folder, WebDAV, or GitHub Gist
- Sync conflict detection and resolution, plus encrypted backup import/export
- Redacting application logs and narrowly scoped Tauri capabilities
- Signed in-app updates and cross-platform release automation

## Stack

- **Desktop:** Tauri 2, Rust, Tokio
- **Frontend:** React 19, TypeScript, Vite, Zustand, TanStack Query, Tailwind
  CSS, Radix UI, xterm.js
- **Backend:** portable-pty, system OpenSSH, SQLite via SQLx, russh-sftp,
  serialport
- **Security:** keyring, Argon2id, XChaCha20-Poly1305

Terminal byte streams flow directly between the Rust backend and xterm.js
through Tauri channels. React stores session metadata, not terminal output.

## Development

### Prerequisites

- [Rust](https://rustup.rs)
- [Node.js](https://nodejs.org) 22 or newer
- [pnpm](https://pnpm.io)
- The [Tauri platform prerequisites](https://tauri.app/start/prerequisites/)
  for your operating system
- A system OpenSSH client for SSH connections

On Linux, serial support also requires the libudev development package (for
example, `libudev-dev` on Ubuntu).

### Run locally

```sh
pnpm install
pnpm tauri dev
```

Run only the browser frontend with:

```sh
pnpm dev
```

Backend-dependent features are unavailable in that mode.

### Checks and builds

```sh
pnpm typecheck
pnpm build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
pnpm tauri build
```

CI runs the frontend build, formatting, Clippy, Rust tests, and native bundle
builds on Windows, macOS, and Linux.

## Project layout

```text
src/                    React application
  features/             Terminal, SSH, SFTP, sync, settings, and other UI
  lib/                  Typed frontend/backend command adapters
  stores/               Zustand application state
src-tauri/
  src/commands/         Tauri command boundary
  src/storage/          SQLite repositories
  src/terminal/         PTY lifecycle and streaming
  src/ssh/              OpenSSH, known-host, and tunnel support
  src/sftp/             File operations and transfers
  src/sync/             Encryption, merge logic, and sync providers
  migrations/           Versioned SQLite schema
docs/                   Build and release documentation
scripts/                Benchmark and Termius export helpers
```

See [the build plan](docs/BUILD_PLAN.md) for the product architecture and
[the release guide](docs/RELEASING.md) for signing and automated release
details. The Termius export helper is documented in
[scripts/README.md](scripts/README.md).

## Releases

Release Please manages versions, changelogs, tags, and draft GitHub releases
from Conventional Commits. Release workflows build installers for Windows,
macOS, and Linux, sign updater artifacts, generate checksums, and publish the
release after verification.

The updater values in the checked-in Tauri configuration are CI placeholders.
A local production bundle must provide its own valid updater endpoint and
public key; see [the release guide](docs/RELEASING.md).

## License

[MIT](LICENSE)
