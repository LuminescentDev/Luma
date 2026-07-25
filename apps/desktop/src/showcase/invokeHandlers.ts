import type { Channel, InvokeArgs } from "./mocks/core";
import { emitWindowEvent } from "./mocks/window";
import type { ThemeMode } from "../types";
import {
  GROUPS,
  HOSTS,
  IDENTITIES,
  KEY_REFERENCES,
  PROFILES,
  RECENT_HOSTS,
  SHELLS,
  SNIPPETS,
  SYNC_CONFIG,
  buildSettings,
} from "./seed";
import {
  DEBIAN_SESSION,
  UBUNTU_SESSION,
  UBUNTU_SESSION_MOBILE,
  fillerSession,
} from "./terminalContent";

type ByteChannel = Channel<ArrayBuffer | number[] | string>;

const NARROW_VIEWPORT_MAX_PX = 600;

function isNarrowViewport(platform: "desktop" | "ios"): boolean {
  if (platform !== "ios") return false;
  return typeof window !== "undefined" && window.innerWidth <= NARROW_VIEWPORT_MAX_PX;
}

const AUTH_FINALIZE_MS = 750;
const CONTENT_DELAY_MS = AUTH_FINALIZE_MS + 350;

let backendSeq = 0;

function driveSsh(
  channel: ByteChannel,
  backendId: string,
  hostId: string,
  sessions: Record<string, string>,
): void {
  const host = HOSTS.find((h) => h.id === hostId);
  const content =
    sessions[hostId] ??
    fillerSession(host?.username ?? "user", host?.name ?? "server");
  const osId = host?.osId ?? "linux";

  setTimeout(() => channel.onmessage("__LUMA_SSH_AUTHENTICATED__\r\n"), 20);
  setTimeout(
    () =>
      emitWindowEvent("ssh-remote-os", {
        sessionId: backendId,
        hostId,
        osId,
        prettyName: host?.osPrettyName ?? null,
      }),
    60,
  );
  setTimeout(() => channel.onmessage(content), CONTENT_DELAY_MS);
}

function driveLocal(channel: ByteChannel): void {
  setTimeout(
    () => channel.onmessage(fillerSession("alex", "workstation")),
    40,
  );
}

export function createInvokeHandler(
  theme: ThemeMode,
  platform: "desktop" | "ios" = "desktop",
): (cmd: string, args: InvokeArgs) => unknown {
  const settings = buildSettings(theme);
  const sessions: Record<string, string> = {
    "h-web-01": isNarrowViewport(platform) ? UBUNTU_SESSION_MOBILE : UBUNTU_SESSION,
    "h-db-01": DEBIAN_SESSION,
  };

  return (cmd, args) => {
    switch (cmd) {
      case "platform_capabilities":
        return platform === "ios" ? {
          os: "ios",
          isMobile: true,
          features: {
            localTerminal: false, serial: false, systemSsh: false, sftp: true,
            portForwarding: false, updater: false, biometrics: true,
            windowControls: false, folderSync: false, dragAndDrop: false,
          },
        } : {
          os: "linux",
          isMobile: false,
          features: {
            localTerminal: true,
            serial: true,
            systemSsh: true,
            sftp: true,
            portForwarding: true,
            updater: true,
            biometrics: false,
            windowControls: true,
            folderSync: true,
            dragAndDrop: true,
          },
        };

      case "settings_get_all":
        return settings;
      case "settings_set":
      case "settings_delete":
        return null;

      case "shells_detect":
        return SHELLS;
      case "profiles_list":
        return PROFILES;

      case "hosts_list":
        return HOSTS;
      case "recent_hosts_list":
        return RECENT_HOSTS;
      case "host_groups_list":
        return GROUPS;
      case "key_references_list":
        return KEY_REFERENCES;
      case "identities_list":
        return IDENTITIES;
      case "ssh_detect":
        return { available: true, path: "/usr/bin/ssh", version: "OpenSSH_9.6p1" };

      case "snippets_list":
        return SNIPPETS;

      case "sync_get_config":
        return SYNC_CONFIG;
      case "tunnels_list":
      case "port_forwards_list":
        return [];
      case "known_hosts_list":
        return [];
      case "serial_ports_list":
        return [];

      case "ssh_host_key_status":
      case "ssh_host_key_trust":
        return { status: "known", scannedKeys: [], knownKeys: [] };

      case "ssh_ping":
      case "ssh_probe":
        return { latencyMs: 21 };

      case "ssh_spawn": {
        const request = (args.request ?? {}) as { hostId?: string };
        const hostId = request.hostId ?? "";
        const host = HOSTS.find((h) => h.id === hostId);
        const backendId = `ssh-${++backendSeq}`;
        driveSsh(args.onData as ByteChannel, backendId, hostId, sessions);
        return { sessionId: backendId, title: host?.name ?? "SSH" };
      }
      case "pty_spawn": {
        const backendId = `pty-${++backendSeq}`;
        driveLocal(args.onData as ByteChannel);
        return { sessionId: backendId, shellName: "bash" };
      }

      case "pty_write":
      case "pty_resize":
      case "pty_kill":
      case "ssh_write":
      case "ssh_resize":
      case "ssh_disconnect":
      case "serial_write":
      case "serial_kill":
        return null;

      default:
        console.warn(`[showcase] unhandled invoke: ${cmd}`);
        return null;
    }
  };
}
