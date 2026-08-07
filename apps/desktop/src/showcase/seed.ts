import type { Host, HostGroup, KeyReference, Identity } from "../lib/hosts";
import type { Snippet } from "../lib/snippets";
import type { Vault } from "../lib/vaults";
import type { DetectedShell, TerminalProfile } from "../lib/terminal";
import type {
  CpuCounters,
  ServerStatsSnapshot,
} from "../lib/serverStats";
import type { SftpEntry, SftpKind } from "../lib/sftp";
import { SETTING_KEYS, type ThemeMode } from "../types";

/** The showcase demonstrates a single-vault workspace. */
const VAULT_ID = "personal";

export const VAULTS: Vault[] = [
  {
    id: VAULT_ID,
    name: "Personal",
    kind: "personal",
    shareSecrets: false,
    sortOrder: 0,
    remoteVaultId: null,
    keyEpoch: 1,
  },
];

export const GROUPS: HostGroup[] = [
  { id: "grp-prod", vaultId: VAULT_ID, name: "Production", parentId: null, sortOrder: 0 },
  { id: "grp-homelab", vaultId: VAULT_ID, name: "Homelab", parentId: null, sortOrder: 1 },
  { id: "grp-cloud", vaultId: VAULT_ID, name: "Cloud", parentId: null, sortOrder: 2 },
];

function host(partial: Partial<Host> & Pick<Host, "id" | "name" | "hostname">): Host {
  return {
    vaultId: VAULT_ID,
    port: 22,
    username: "deploy",
    groupId: null,
    authenticationType: "key",
    keyId: "key-ed25519",
    identityId: null,
    proxyJumpHostId: null,
    startupCommand: null,
    workingDirectory: null,
    environment: null,
    tags: [],
    favorite: false,
    transport: "ssh",
    moshServerPath: null,
    moshPortRange: null,
    osId: null,
    osPrettyName: null,
    tabColor: null,
    isEphemeral: false,
    ...partial,
  };
}

export const HOSTS: Host[] = [
  host({
    id: "h-web-01",
    name: "vps-0cd97c22",
    hostname: "158.69.198.249",
    username: "ubuntu",
    groupId: "grp-prod",
    tags: ["web", "nginx"],
    favorite: true,
    osId: "ubuntu",
    osPrettyName: "Ubuntu 25.04",
    tabColor: "#4ade80",
  }),
  host({
    id: "h-web-02",
    name: "prod-web-02",
    hostname: "10.0.4.12",
    groupId: "grp-prod",
    tags: ["web", "nginx"],
    osId: "ubuntu",
    osPrettyName: "Ubuntu 24.04.1 LTS",
  }),
  host({
    id: "h-db-01",
    name: "db-primary",
    hostname: "10.0.4.20",
    username: "root",
    groupId: "grp-prod",
    tags: ["postgres", "primary"],
    favorite: true,
    osId: "debian",
    osPrettyName: "Debian GNU/Linux 12",
    tabColor: "#60a5fa",
  }),
  host({
    id: "h-cache-01",
    name: "cache-redis",
    hostname: "10.0.4.31",
    groupId: "grp-prod",
    tags: ["redis"],
    osId: "alpine",
    osPrettyName: "Alpine Linux 3.20",
  }),
  host({
    id: "h-nas",
    name: "homelab-nas",
    hostname: "192.168.1.10",
    username: "admin",
    groupId: "grp-homelab",
    tags: ["storage", "zfs"],
    favorite: true,
    osId: "freebsd",
    osPrettyName: "TrueNAS 13.0",
  }),
  host({
    id: "h-pi",
    name: "pihole",
    hostname: "192.168.1.4",
    username: "pi",
    groupId: "grp-homelab",
    tags: ["dns", "ads"],
    osId: "raspbian",
    osPrettyName: "Raspberry Pi OS",
  }),
  host({
    id: "h-arch",
    name: "workstation",
    hostname: "192.168.1.50",
    username: "alex",
    groupId: "grp-homelab",
    tags: ["desktop"],
    osId: "arch",
    osPrettyName: "Arch Linux",
  }),
  host({
    id: "h-edge",
    name: "edge-fedora",
    hostname: "203.0.113.9",
    groupId: "grp-cloud",
    tags: ["edge", "k3s"],
    osId: "fedora",
    osPrettyName: "Fedora Linux 40",
  }),
  host({
    id: "h-build",
    name: "ci-runner",
    hostname: "203.0.113.24",
    groupId: "grp-cloud",
    tags: ["ci", "docker"],
    osId: "rocky",
    osPrettyName: "Rocky Linux 9.4",
  }),
];

export const RECENT_HOSTS: Host[] = [
  HOSTS[0],
  HOSTS[2],
  HOSTS[4],
];

export const SNIPPETS: Snippet[] = [
  {
    vaultId: VAULT_ID,
    id: "s-tail",
    name: "Tail nginx errors",
    command: "sudo tail -f /var/log/nginx/error.log",
    description: "Live-follow the nginx error log",
    tags: ["nginx", "logs"],
    variables: [],
    hostId: null,
  },
  {
    vaultId: VAULT_ID,
    id: "s-disk",
    name: "Disk usage (top 20)",
    command: "du -ahx / | sort -rh | head -n 20",
    description: "Largest files and directories on the root volume",
    tags: ["disk", "cleanup"],
    variables: [],
    hostId: null,
  },
  {
    vaultId: VAULT_ID,
    id: "s-restart",
    name: "Restart service",
    command: "sudo systemctl restart {{service}} && systemctl status {{service}}",
    description: "Restart a systemd unit and show its status",
    tags: ["systemd"],
    variables: ["service"],
    hostId: null,
  },
  {
    vaultId: VAULT_ID,
    id: "s-docker",
    name: "Prune docker",
    command: "docker system prune -af --volumes",
    description: "Reclaim space from stopped containers and dangling images",
    tags: ["docker", "cleanup"],
    variables: [],
    hostId: "h-build",
  },
  {
    vaultId: VAULT_ID,
    id: "s-ports",
    name: "Listening ports",
    command: "ss -tulpn | grep LISTEN",
    description: "Show all listening TCP/UDP sockets",
    tags: ["network"],
    variables: [],
    hostId: null,
  },
  {
    vaultId: VAULT_ID,
    id: "s-backup",
    name: "Snapshot postgres",
    command: "pg_dump -Fc {{database}} > /backups/{{database}}-$(date +%F).dump",
    description: "Create a compressed database snapshot",
    tags: ["postgres", "backup"],
    variables: ["database"],
    hostId: "h-db-01",
  },
];

export const SHELLS: DetectedShell[] = [
  { id: "bash", name: "Bash", path: "/bin/bash", args: [] },
  { id: "zsh", name: "Zsh", path: "/bin/zsh", args: [] },
  { id: "pwsh", name: "PowerShell", path: "/usr/bin/pwsh", args: ["-NoLogo"] },
];

export const PROFILES: TerminalProfile[] = [
  {
    id: "prof-devbox",
    name: "Dev box (tmux)",
    shellPath: "/bin/bash",
    args: ["-lc", "tmux new -A -s dev"],
    workingDirectory: "/home/alex/code",
    environment: null,
  },
];

export const KEY_REFERENCES: KeyReference[] = [
  {
    vaultId: VAULT_ID,
    id: "key-ed25519",
    name: "id_ed25519 (primary)",
    publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI... alex@workstation",
    storageMode: "local-path",
    localPath: "~/.ssh/id_ed25519",
    fingerprint: "SHA256:9Xt6Qop+Zr8n0mJ4b3wKqg1sQb2v7Yh9c0dEfGhIjk",
    certificate: null,
    hasPrivateKey: true,
  },
  {
    vaultId: VAULT_ID,
    id: "key-vault",
    name: "deploy (vault)",
    publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI... deploy@luma",
    storageMode: "encrypted-vault",
    localPath: null,
    fingerprint: "SHA256:Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78St90Uvw",
    certificate: null,
    hasPrivateKey: true,
  },
];

export const IDENTITIES: Identity[] = [
  { id: "id-deploy", vaultId: VAULT_ID, name: "deploy", username: "deploy", keyId: "key-ed25519", hasPassword: false },
  { id: "id-admin", vaultId: VAULT_ID, name: "homelab admin", username: "admin", keyId: "key-vault", hasPassword: true },
];

export function buildSettings(theme: ThemeMode): Record<string, unknown> {
  return {
    [SETTING_KEYS.theme]: theme,
    [SETTING_KEYS.fontSize]: 14,
    [SETTING_KEYS.scrollback]: 5000,
    [SETTING_KEYS.terminalScheme]: "auto",
    [SETTING_KEYS.checkOnLaunch]: false,
    [SETTING_KEYS.restoreSessions]: false,
    [SETTING_KEYS.autoReconnect]: true,
    // An explicit choice, so the first-run consent prompt cannot fire over a
    // marketing screenshot.
    [SETTING_KEYS.analytics]: false,
  };
}

export const SYNC_CONFIG = {
  vaultId: VAULT_ID,
  enabled: false,
  provider: null,
  folderPath: null,
  url: null,
  username: null,
  gistId: null,
  cloudUrl: null,
  cloudSignedIn: false,
  lastSyncAt: null,
  lastRemoteVersion: null,
  passphraseSet: false,
  passphraseRemembered: false,
};

/*
 * Server dashboard, files and agent inbox data.
 *
 * These screens are new in 0.16 and have no backend in the showcase, so the
 * shapes below stand in for what an SSH round trip would return. Everything is
 * deterministic: the App Store shots have to be reproducible, so nothing here
 * reads the clock or randomises.
 */

/** The host the dashboard scenario points at. */
export const STATS_HOST = { id: "h-web-01", name: "vps-0cd97c22" };

/* CPU and network counters are cumulative — the dashboard derives utilization
 * and throughput from the delta between two samples, so a single frozen
 * snapshot renders "waiting for next sample…" and empty meters. `sample`
 * advances the counters at a fixed rate to give the second fetch something to
 * subtract. Deltas are sized in jiffies for a ~2s gap on 4 cores. */
function cpuCore(name: string, sample: number, busyPerSample: number): CpuCounters {
  const idlePerSample = 200 - busyPerSample;
  return {
    name,
    user: 120_000 + sample * Math.round(busyPerSample * 0.72),
    nice: 400,
    system: 45_000 + sample * Math.round(busyPerSample * 0.24),
    idle: 980_000 + sample * idlePerSample,
    iowait: 3_200 + sample * 3,
    irq: 0,
    softirq: 900 + sample * Math.round(busyPerSample * 0.04),
    steal: 0,
  };
}

export function serverStatsSnapshot(sample: number): ServerStatsSnapshot {
  const cores = [
    cpuCore("cpu0", sample, 78),
    cpuCore("cpu1", sample, 41),
    cpuCore("cpu2", sample, 63),
    cpuCore("cpu3", sample, 22),
  ];
  return {
    system: {
      os: "linux",
      osPrettyName: "Ubuntu 24.04.2 LTS",
      kernel: "6.8.0-51-generic",
      arch: "x86_64",
      hostname: "vps-0cd97c22",
      uptimeSeconds: 1_904_732,
      uptimeText: null,
    },
    cpu: {
      total: cpuCore("cpu", sample, 51),
      cores,
      loadAverage: [0.62, 0.74, 0.81],
    },
    memory: {
      totalKb: 8_138_240,
      freeKb: 612_400,
      availableKb: 4_281_920,
      buffersKb: 198_640,
      cachedKb: 3_470_880,
      swapTotalKb: 2_097_148,
      swapFreeKb: 2_097_148,
    },
    disks: [
      {
        filesystem: "/dev/vda1",
        mountPoint: "/",
        totalKb: 75_057_664,
        usedKb: 32_284_672,
        availableKb: 42_772_992,
        usedPercent: 43,
      },
      {
        filesystem: "/dev/vdb1",
        mountPoint: "/mnt/backups",
        totalKb: 209_715_200,
        usedKb: 96_468_992,
        availableKb: 113_246_208,
        usedPercent: 46,
      },
    ],
    network: [
      {
        name: "eth0",
        rxBytes: 84_211_998_720 + sample * 2_412_544,
        txBytes: 31_884_562_432 + sample * 1_048_576,
      },
      {
        name: "wg0",
        rxBytes: 4_233_871_360 + sample * 131_072,
        txBytes: 2_918_744_064 + sample * 98_304,
      },
    ],
    topProcesses: {
      byCpu: [
        { pid: 1284, user: "postgres", cpuPercent: 24.6, memPercent: 11.2, command: "postgres: writer process" },
        { pid: 998, user: "ubuntu", cpuPercent: 12.1, memPercent: 6.4, command: "node /srv/api/server.js" },
        { pid: 2210, user: "root", cpuPercent: 6.8, memPercent: 2.1, command: "dockerd" },
        { pid: 1477, user: "www-data", cpuPercent: 3.2, memPercent: 1.8, command: "nginx: worker process" },
        { pid: 640, user: "root", cpuPercent: 1.4, memPercent: 0.9, command: "containerd" },
      ],
      byMemory: [
        { pid: 1284, user: "postgres", cpuPercent: 24.6, memPercent: 11.2, command: "postgres: writer process" },
        { pid: 998, user: "ubuntu", cpuPercent: 12.1, memPercent: 6.4, command: "node /srv/api/server.js" },
        { pid: 1806, user: "redis", cpuPercent: 0.8, memPercent: 4.7, command: "redis-server *:6379" },
        { pid: 2210, user: "root", cpuPercent: 6.8, memPercent: 2.1, command: "dockerd" },
        { pid: 1477, user: "www-data", cpuPercent: 3.2, memPercent: 1.8, command: "nginx: worker process" },
      ],
    },
    docker: [
      { name: "api", state: "running", status: "Up 6 days", image: "ghcr.io/luma/api:1.8.2", health: "healthy" },
      { name: "postgres", state: "running", status: "Up 6 days", image: "postgres:16-alpine", health: "healthy" },
      { name: "redis", state: "running", status: "Up 6 days", image: "redis:7-alpine", health: null },
      { name: "caddy", state: "running", status: "Up 2 hours", image: "caddy:2", health: "starting" },
    ],
    failedServices: [],
    // Fixed: `new Date(...).toLocaleTimeString()` in the header would otherwise
    // differ between capture runs. 2026-01-01 09:41:00 UTC.
    sampledAtMs: 1_767_260_460_000,
  };
}

/** Remote listing for the Files screen, shown for the primary host. */
export const SFTP_INITIAL_PATH = "/home/ubuntu";

function entry(
  name: string,
  kind: SftpKind,
  size: number | null,
  modifiedAt: number,
  permissions: string,
): SftpEntry {
  return { name, path: `${SFTP_INITIAL_PATH}/${name}`, kind, size, modifiedAt, permissions };
}

export const SFTP_LISTING: SftpEntry[] = [
  entry("deploy", "dir", null, 1_766_916_000, "rwxr-xr-x"),
  entry("logs", "dir", null, 1_767_174_000, "rwxr-xr-x"),
  entry("scripts", "dir", null, 1_766_483_000, "rwxr-xr-x"),
  entry("backups", "dir", null, 1_767_225_600, "rwx------"),
  entry("docker-compose.yml", "file", 3_412, 1_767_218_400, "rw-r--r--"),
  entry("nginx.conf", "file", 8_976, 1_766_829_600, "rw-r--r--"),
  entry(".env.production", "file", 1_204, 1_767_045_600, "rw-------"),
  entry("api-1.8.2.tar.gz", "file", 48_312_704, 1_767_232_800, "rw-r--r--"),
  entry("dump-2026-01-01.sql", "file", 214_958_080, 1_767_256_800, "rw-r--r--"),
  entry("README.md", "file", 2_048, 1_765_792_800, "rw-r--r--"),
];
