# Luma

Lightweight cross-platform terminal and SSH client (Tauri 2 + Rust backend, React 19 + TypeScript + Vite frontend).

**The authoritative spec is [docs/BUILD_PLAN.md](docs/BUILD_PLAN.md).** Read it before implementing features — it defines the architecture, phases, completion criteria, security requirements, and non-goals. Its "Decisions Log" and "Progress" sections record project-specific choices; keep them updated as phases complete.

## Commands

```sh
pnpm install                                        # install frontend deps
pnpm tauri dev                                      # run the app
pnpm build                                          # typecheck + build frontend
cargo test --manifest-path src-tauri/Cargo.toml     # backend tests
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo fmt --manifest-path src-tauri/Cargo.toml      # CI enforces fmt + clippy
```

## Architecture invariants

- Terminal bytes NEVER pass through React state. Rust PTY → Tauri channel (`InvokeResponseBody::Raw`) → xterm.js, managed by `src/features/terminal/terminalManager.ts` outside React. React stores hold session metadata only.
- The frontend never passes raw executable paths to spawn; `pty_spawn` accepts only detected shell ids or stored profile ids.
- Secrets never go in plain SQLite columns or logs (logger redacts; see `src-tauri/src/logging/`). Schema changes are new files in `src-tauri/migrations/`, never edits to shipped migrations.
- Tauri capabilities stay strict (`src-tauri/capabilities/`); no unrestricted fs/process APIs exposed to the frontend.

## Windows PTY gotchas (cost real debugging time)

- ConPTY is created with INHERIT_CURSOR: headless tests must reply `\x1b[1;1R` to the `ESC[6n` query after spawning or the child stalls (xterm.js answers it automatically in the app).
- The ConPTY reader only receives EOF after the PTY master is dropped: the waiter thread reaps the child, then removes the session (dropping the master) to unblock the reader. Keep that ordering.
