import { spawn, execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { hostname, platform, release } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const resultsDir = resolve(root, 'scripts', 'benchmark-results');
const startupTimeoutMs = positiveNumber(process.env.LUMA_BENCH_STARTUP_TIMEOUT_MS, 15_000);
const idleSampleMs = positiveNumber(process.env.LUMA_BENCH_IDLE_SAMPLE_MS, 5_000);
const sampleIntervalMs = positiveNumber(process.env.LUMA_BENCH_SAMPLE_INTERVAL_MS, 500);
const readyFile = process.env.LUMA_BENCH_READY_FILE
  ? resolve(process.env.LUMA_BENCH_READY_FILE)
  : null;

const binaryCandidates = candidateBinaries();
const requestedBinary = process.argv[2] || process.env.LUMA_BENCH_BINARY;
const checkedPaths = requestedBinary ? [resolve(requestedBinary)] : binaryCandidates;
const binaryPath = checkedPaths.find((candidate) => existsSync(candidate));

if (!binaryPath) {
  console.error('Luma benchmark: built binary not found.');
  console.error('Build it first with: pnpm tauri build');
  console.error('Or set LUMA_BENCH_BINARY / pass the binary path as the first argument.');
  console.error('Checked:');
  for (const candidate of checkedPaths) {
    console.error(`  - ${candidate}`);
  }
  process.exitCode = 0;
} else {
  await runBenchmark(binaryPath);
}

function candidateBinaries() {
  const target = resolve(root, 'apps', 'desktop', 'src-tauri', 'target', 'release');
  if (process.platform === 'win32') {
    return [resolve(target, 'luma.exe')];
  }
  if (process.platform === 'darwin') {
    return [
      resolve(target, 'luma'),
      resolve(target, 'bundle', 'macos', 'Luma.app', 'Contents', 'MacOS', 'Luma'),
    ];
  }
  return [
    resolve(target, 'luma'),
    resolve(target, 'bundle', 'appimage', 'Luma.AppImage'),
  ];
}

async function runBenchmark(executable) {
  if (readyFile && existsSync(readyFile)) {
    rmSync(readyFile);
  }

  const startedAt = new Date();
  const startMark = performance.now();
  const child = spawn(executable, [], {
    cwd: dirname(executable),
    env: { ...process.env, LUMA_BENCHMARK: '1' },
    stdio: 'ignore',
    windowsHide: false,
  });

  const state = {
    exited: false,
    exitCode: null,
    signal: null,
    spawnError: null,
  };
  child.once('error', (error) => {
    state.spawnError = error.message;
  });
  child.once('exit', (code, signal) => {
    state.exited = true;
    state.exitCode = code;
    state.signal = signal;
  });

  await onceSpawnedOrFailed(child, state);
  const spawnElapsedMs = round(performance.now() - startMark);
  if (state.spawnError) {
    throw new Error(`Unable to launch ${executable}: ${state.spawnError}`);
  }

  const readiness = await waitForReadiness(child.pid, state, startMark);
  const memorySamples = state.exited
    ? []
    : await sampleRss(child.pid, state, idleSampleMs, sampleIntervalMs);

  if (!state.exited) {
    await stopProcess(child.pid, child);
  }

  const report = {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    host: {
      hostname: hostname(),
      platform: platform(),
      osRelease: release(),
      node: process.version,
    },
    binary: {
      path: executable,
      name: basename(executable),
    },
    configuration: {
      startupTimeoutMs,
      idleSampleMs,
      sampleIntervalMs,
      readyFile,
    },
    process: {
      pid: child.pid,
      spawnElapsedMs,
      exitedBeforeCleanup: state.exited,
      exitCode: state.exitCode,
      signal: state.signal,
    },
    coldStartup: {
      status: readiness.status,
      elapsedMs: readiness.elapsedMs,
      signal: readiness.signal,
      note: readiness.note,
    },
    idleMemory: summarizeMemory(memorySamples, readiness.status),
    manualBenchmarks: manualBenchmarkScaffolds(),
    durationMs: round(new Date() - startedAt),
  };

  mkdirSync(resultsDir, { recursive: true });
  const resultPath = resolve(resultsDir, `${fileTimestamp(report.recordedAt)}.json`);
  writeFileSync(resultPath, `${JSON.stringify(report, null, 2)}\n`);

  printReport(report, resultPath);
}

function onceSpawnedOrFailed(child, state) {
  return new Promise((resolvePromise) => {
    if (child.pid || state.spawnError) {
      resolvePromise();
      return;
    }
    child.once('spawn', resolvePromise);
    child.once('error', resolvePromise);
  });
}

async function waitForReadiness(pid, state, startMark) {
  while (performance.now() - startMark < startupTimeoutMs) {
    if (state.exited) {
      return {
        status: 'exited',
        elapsedMs: round(performance.now() - startMark),
        signal: 'process-exit',
        note: 'The process exited before a ready signal was observed.',
      };
    }

    const signal = detectReadySignal(pid);
    if (signal) {
      return {
        status: 'ready',
        elapsedMs: round(performance.now() - startMark),
        signal,
        note: signal === 'ready-file'
          ? 'Ready-file instrumentation supplied an explicit readiness signal.'
          : 'OS window detection observed a visible Luma process.',
      };
    }
    await delay(100);
  }

  return {
    status: 'timeout',
    elapsedMs: round(performance.now() - startMark),
    signal: null,
    note: 'No reliable ready signal was available before timeout; this is a timeout, not a fabricated startup measurement. Set LUMA_BENCH_READY_FILE for instrumented runs.',
  };
}

function detectReadySignal(pid) {
  if (readyFile && existsSync(readyFile)) {
    return 'ready-file';
  }

  try {
    if (process.platform === 'win32') {
      const output = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$process = Get-Process -Id ${pid} -ErrorAction Stop; [Console]::Write($process.MainWindowHandle)`,
        ],
        { encoding: 'utf8', windowsHide: true },
      ).trim();
      return Number(output) > 0 ? 'windows-main-window' : null;
    }

    if (process.platform === 'darwin') {
      const script = `tell application "System Events" to get visible of first process whose unix id is ${pid}`;
      const output = execFileSync('osascript', ['-e', script], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return output === 'true' ? 'macos-visible-process' : null;
    }

    const output = execFileSync('wmctrl', ['-lp'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output.split(/\r?\n/).some((line) => line.split(/\s+/)[2] === String(pid))
      ? 'linux-window'
      : null;
  } catch {
    return null;
  }
}

async function sampleRss(pid, state, durationMs, intervalMs) {
  const samples = [];
  const deadline = performance.now() + durationMs;
  while (!state.exited && performance.now() < deadline) {
    const rssBytes = readRssBytes(pid);
    if (rssBytes !== null) {
      samples.push({
        elapsedMs: round(performance.now() - (deadline - durationMs)),
        rssBytes,
      });
    }
    await delay(intervalMs);
  }
  return samples;
}

function readRssBytes(pid) {
  try {
    if (process.platform === 'win32') {
      const output = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$process = Get-Process -Id ${pid} -ErrorAction Stop; [Console]::Write($process.WorkingSet64)`,
        ],
        { encoding: 'utf8', windowsHide: true },
      ).trim();
      const value = Number(output);
      return Number.isFinite(value) ? value : null;
    }

    const output = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const kibibytes = Number(output);
    return Number.isFinite(kibibytes) ? kibibytes * 1024 : null;
  } catch {
    return null;
  }
}

function summarizeMemory(samples, readinessStatus) {
  if (samples.length === 0) {
    return {
      status: 'unavailable',
      sampleCount: 0,
      sampleDurationMs: idleSampleMs,
      source: process.platform === 'win32' ? 'Get-Process.WorkingSet64' : 'ps rss',
      note: 'The process exited or RSS could not be sampled.',
    };
  }

  const values = samples.map(({ rssBytes }) => rssBytes).sort((a, b) => a - b);
  return {
    status: readinessStatus === 'ready' ? 'measured' : 'measured-after-startup-timeout',
    sampleCount: values.length,
    sampleDurationMs: idleSampleMs,
    source: process.platform === 'win32' ? 'Get-Process.WorkingSet64' : 'ps rss',
    rssBytes: {
      min: values[0],
      max: values.at(-1),
      mean: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length),
      p50: percentile(values, 0.5),
      p95: percentile(values, 0.95),
    },
    note: readinessStatus === 'ready'
      ? 'RSS sampled after the ready signal while the app was otherwise idle.'
      : 'RSS was sampled, but no reliable UI-ready signal was observed; interpret it separately from a verified idle-memory result.',
  };
}

function manualBenchmarkScaffolds() {
  return [
    {
      metric: 'memoryPerTerminalSession',
      status: 'manual-todo',
      procedure: 'Record baseline RSS, open 1/5/10 identical local terminals, wait 5 seconds after each step, and record the RSS delta divided by active session count.',
    },
    {
      metric: 'cpuDuringHighOutput',
      status: 'manual-todo',
      procedure: 'Run a fixed high-output command in one terminal for 30 seconds and sample process CPU with Task Manager/Get-Counter, top/ps, or Activity Monitor. Record command, terminal size, and output rate.',
    },
    {
      metric: 'memoryAfterTwentySessionCycles',
      status: 'manual-todo',
      procedure: 'Record idle RSS, open and fully close 20 terminal sessions, wait for cleanup, then record RSS and verify child processes are gone.',
    },
    {
      metric: 'largeScrollback',
      status: 'manual-todo',
      procedure: 'Emit enough deterministic output to fill the configured scrollback limit, then record RSS, CPU, input latency, and whether scrolling remains responsive.',
    },
    {
      metric: 'sftpTransferMemory',
      status: 'manual-todo',
      procedure: 'Transfer a fixed large file in each direction over SFTP, sample peak RSS during transfer, verify cancellation, and confirm RSS returns near baseline afterward.',
    },
  ];
}

async function stopProcess(pid, child) {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      return;
    }
    child.kill('SIGTERM');
    await delay(1_000);
    if (!child.killed) {
      child.kill('SIGKILL');
    }
  } catch {
    // The process may have exited between the last sample and cleanup.
  }
}

function printReport(report, resultPath) {
  const rss = report.idleMemory.rssBytes;
  console.log(JSON.stringify(report, null, 2));
  console.log('\nSummary');
  console.table([
    {
      metric: 'Cold startup',
      status: report.coldStartup.status,
      value: `${report.coldStartup.elapsedMs} ms`,
      source: report.coldStartup.signal || 'none',
    },
    {
      metric: 'Idle RSS mean',
      status: report.idleMemory.status,
      value: rss ? `${(rss.mean / 1024 / 1024).toFixed(1)} MiB` : 'unavailable',
      source: report.idleMemory.source,
    },
  ]);
  console.log(`Benchmark result written to ${resultPath}`);
}

function percentile(sortedValues, fraction) {
  return sortedValues[Math.min(sortedValues.length - 1, Math.ceil(sortedValues.length * fraction) - 1)];
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function fileTimestamp(value) {
  return value.replace(/[:.]/g, '-');
}

function round(value) {
  return Math.round(Number(value) * 100) / 100;
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
