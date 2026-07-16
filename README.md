# Luma

A lightweight, cross-platform terminal and SSH client for Windows, macOS, and Linux.

Luma aims to sit between Tabby and Electerm: a modern, minimal interface with
materially lower memory usage than Electron-based terminals, saved SSH hosts
and groups, local terminals, and optional end-to-end-encrypted sync — no
account, no paid cloud service.

> **Status: early development.** The application shell, settings storage,
> theming, and CI foundation are in place. Terminal rendering, SSH, SFTP, and
> sync are being built in milestones — see [Roadmap](#roadmap).

## Stack

- **Shell:** Tauri 2 (Rust backend, WebView frontend)
- **Frontend:** React + TypeScript + Vite, Zustand, TanStack Query, Tailwind CSS, Radix UI, xterm.js (upcoming)
- **Backend:** Tokio, SQLite via SQLx (versioned migrations), portable-pty (upcoming), system OpenSSH (upcoming)
- **Security:** OS keychain integration, Argon2id + XChaCha20-Poly1305 encrypted vault for sync (upcoming)

## Development

Prerequisites: [Rust](https://rustup.rs), [Node.js](https://nodejs.org) 22+, [pnpm](https://pnpm.io), and the
[Tauri platform prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```sh
pnpm install
pnpm tauri dev      # run the app
pnpm build          # typecheck + build frontend
cargo test --manifest-path src-tauri/Cargo.toml    # backend tests
```

## Design principles

- Terminal byte streams flow directly between Rust and xterm.js over Tauri
  channels — never through React state.
- Secrets never land in plain SQLite columns, logs, or sync payloads; sync
  providers only ever receive encrypted blobs.
- SSH host keys are never accepted automatically.
- Strict Tauri capability permissions; no unrestricted filesystem or process
  APIs exposed to the frontend.

## Roadmap

1. ✅ Foundation — app shell, sidebar, tabs, settings storage, SQLite migrations, theming, redacting logger, CI
2. Local terminals — PTY backend, xterm.js, shell profiles, search, scrollback
3. SSH — hosts, groups, OpenSSH adapter, known-host verification, `~/.ssh/config` import, ProxyJump
4. Productivity — split panes, command palette, snippets, port forwarding
5. Encryption & sync — vault, OS keychain, local folder / WebDAV / GitHub Gist providers
6. SFTP — dual-pane browser, transfer queue
7. Release hardening — auto-update, signing, benchmarks, accessibility

## License

[MIT](LICENSE)
