import { Channel, invoke } from "@tauri-apps/api/core";

/*
 * Typed invoke wrappers for the port-forwarding backend. Tunnel start mirrors
 * src/lib/ssh.ts: a Channel streams the exit event. The frontend only ever
 * sends stored port-forward ids — never raw ssh arguments.
 */

export type PortForwardType = "local" | "remote" | "dynamic";

export type PortForward = {
  id: string;
  hostId: string;
  name: string;
  type: PortForwardType;
  bindAddress: string;
  localPort: number | null;
  destinationHost: string | null;
  destinationPort: number | null;
  remotePort: number | null;
};

export type PortForwardInput = {
  hostId: string;
  name: string;
  type: PortForwardType;
  bindAddress?: string;
  localPort?: number | null;
  destinationHost?: string | null;
  destinationPort?: number | null;
  remotePort?: number | null;
};

export type TunnelExit = {
  code: number | null;
  errorCategory: string | null;
  errorMessage: string | null;
};

export type TunnelInfo = {
  tunnelId: string;
  portForwardId: string;
  hostId: string;
  status: string;
};

export function listPortForwards(hostId?: string): Promise<PortForward[]> {
  return invoke<PortForward[]>("port_forwards_list", { hostId });
}

export function createPortForward(input: PortForwardInput): Promise<PortForward> {
  return invoke<PortForward>("port_forward_create", { input });
}

export function updatePortForward(
  id: string,
  input: PortForwardInput,
): Promise<PortForward> {
  return invoke<PortForward>("port_forward_update", { id, input });
}

export function deletePortForward(id: string): Promise<void> {
  return invoke<void>("port_forward_delete", { id });
}

export function startTunnel(
  portForwardId: string,
  onExit: (exit: TunnelExit) => void,
): Promise<{ tunnelId: string }> {
  const exitChannel = new Channel<TunnelExit>();
  exitChannel.onmessage = onExit;
  return invoke<{ tunnelId: string }>("tunnel_start", {
    portForwardId,
    onExit: exitChannel,
  });
}

export function stopTunnel(tunnelId: string): Promise<void> {
  return invoke<void>("tunnel_stop", { tunnelId });
}

export function listTunnels(): Promise<TunnelInfo[]> {
  return invoke<TunnelInfo[]>("tunnels_list");
}
