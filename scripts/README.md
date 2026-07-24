# Termius migration tools

`Export-TermiusVault.ps1` creates a read-only snapshot of the IndexedDB stores
used by Termius Desktop on Windows. It does not stop Termius, accept a vault
password, modify the Termius profile, or print record values.

Close Termius completely, then run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\Export-TermiusVault.ps1
```

Unlock Termius in the window opened by the script and return to PowerShell when
prompted. The resulting `termius-vault-export.json` is restricted to the current
Windows account. Treat it as a secret: depending on the Termius vault mode, it
can contain encrypted or locally available credential and private-key material.

The snapshot is an intermediate migration bundle. Import into Luma should only
be performed after the bundle passes schema validation and an item-count preview.

## Performance benchmark

Build Luma, then run the dependency-free Node benchmark:

```sh
pnpm tauri build
node scripts/benchmark.mjs
```

You can pass a binary path directly or set `LUMA_BENCH_BINARY` when the default
`apps/desktop/src-tauri/target/release` location is not appropriate:

```sh
node scripts/benchmark.mjs /path/to/luma
```

The script times process launch through an explicit ready signal, an OS-visible
window, or the configured timeout. It samples resident set size (RSS) with
`Get-Process` on Windows or `ps` on macOS/Linux, prints JSON plus a summary table,
and writes timestamped JSON to `scripts/benchmark-results/`.

For instrumented/headless startup measurements, set `LUMA_BENCH_READY_FILE` to a
path that the running app or test harness creates when initialization is complete.
Timeout and sampling durations can be adjusted with
`LUMA_BENCH_STARTUP_TIMEOUT_MS`, `LUMA_BENCH_IDLE_SAMPLE_MS`, and
`LUMA_BENCH_SAMPLE_INTERVAL_MS`.

Metrics that require UI automation or a live terminal/SFTP workload are not
fabricated. Each JSON report includes manual procedures for memory per terminal,
CPU during high output, memory after opening/closing 20 sessions, large
scrollback, and SFTP transfer memory.

Updater release-key setup and release artifact details are documented in
`docs/RELEASING.md`.
