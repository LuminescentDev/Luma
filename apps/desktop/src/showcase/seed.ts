import type { Host, HostGroup, KeyReference, Identity } from "../lib/hosts";
import type { Snippet } from "../lib/snippets";
import type { DetectedShell, TerminalProfile } from "../lib/terminal";
import { SETTING_KEYS, type ThemeMode } from "../types";

export const GROUPS: HostGroup[] = [
  { id: "grp-prod", name: "Production", parentId: null, sortOrder: 0 },
  { id: "grp-homelab", name: "Homelab", parentId: null, sortOrder: 1 },
  { id: "grp-cloud", name: "Cloud", parentId: null, sortOrder: 2 },
];

function host(partial: Partial<Host> & Pick<Host, "id" | "name" | "hostname">): Host {
  return {
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
    id: "s-tail",
    name: "Tail nginx errors",
    command: "sudo tail -f /var/log/nginx/error.log",
    description: "Live-follow the nginx error log",
    tags: ["nginx", "logs"],
    variables: [],
    hostId: null,
  },
  {
    id: "s-disk",
    name: "Disk usage (top 20)",
    command: "du -ahx / | sort -rh | head -n 20",
    description: "Largest files and directories on the root volume",
    tags: ["disk", "cleanup"],
    variables: [],
    hostId: null,
  },
  {
    id: "s-restart",
    name: "Restart service",
    command: "sudo systemctl restart {{service}} && systemctl status {{service}}",
    description: "Restart a systemd unit and show its status",
    tags: ["systemd"],
    variables: ["service"],
    hostId: null,
  },
  {
    id: "s-docker",
    name: "Prune docker",
    command: "docker system prune -af --volumes",
    description: "Reclaim space from stopped containers and dangling images",
    tags: ["docker", "cleanup"],
    variables: [],
    hostId: "h-build",
  },
  {
    id: "s-ports",
    name: "Listening ports",
    command: "ss -tulpn | grep LISTEN",
    description: "Show all listening TCP/UDP sockets",
    tags: ["network"],
    variables: [],
    hostId: null,
  },
  {
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
  { id: "id-deploy", name: "deploy", username: "deploy", keyId: "key-ed25519", hasPassword: false },
  { id: "id-admin", name: "homelab admin", username: "admin", keyId: "key-vault", hasPassword: true },
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
  };
}

export const SYNC_CONFIG = {
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
  passphraseRemembered: false,
};
