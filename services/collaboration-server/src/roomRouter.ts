import type { RedisClientType } from "redis";
import { WebSocket } from "ws";
import type { Config } from "./config.js";
import {
  canPublish,
  parseClientMessage,
  ProtocolError,
  type ClientMessage,
} from "@luma/collaboration-protocol";
import type { RealtimeTicket } from "./tickets.js";

interface Connection {
  socket: WebSocket;
  identity: RealtimeTicket;
  queue: Promise<void>;
  rateTokens: number;
  rateUpdatedAt: number;
}

const PUBLISH_SCRIPT = `
local sequence = redis.call('INCR', KEYS[1])
local event = cjson.decode(ARGV[1])
event.roomSequence = sequence
local encoded = cjson.encode(event)
redis.call('XADD', KEYS[2], 'MAXLEN', '~', ARGV[2], tostring(sequence) .. '-0', 'event', encoded)
redis.call('PUBLISH', KEYS[3], encoded)
return sequence
`;

const ACQUIRE_CONTROL_SCRIPT = `
local owner = redis.call('GET', KEYS[1])
if not owner or owner == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
  return 1
end
return 0
`;

const RELEASE_CONTROL_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export class RoomRouter {
  private readonly rooms = new Map<string, Set<Connection>>();

  constructor(
    private readonly command: RedisClientType,
    private readonly subscriber: RedisClientType,
    private readonly config: Config,
  ) {}

  async attach(socket: WebSocket, identity: RealtimeTicket): Promise<void> {
    let connections = this.rooms.get(identity.roomId);
    if (!connections) {
      connections = new Set();
      this.rooms.set(identity.roomId, connections);
      await this.subscriber.subscribe(this.channelKey(identity.roomId), (message) => {
        this.broadcastLocal(identity.roomId, message);
      });
    }
    const connection: Connection = {
      socket,
      identity,
      queue: Promise.resolve(),
      rateTokens: this.config.websocketMessagesPerSecond,
      rateUpdatedAt: Date.now(),
    };
    connections.add(connection);
    await this.updatePresence(identity, null);
    await this.publish(identity.roomId, {
      type: "presence.joined",
      memberId: identity.memberId,
      connectionId: identity.connectionId,
    });

    socket.on("message", (data, isBinary) => {
      connection.queue = connection.queue
        .then(async () => {
          if (isBinary) throw new ProtocolError("binary WebSocket messages are not supported");
          await this.handle(connection, data.toString());
        })
        .catch((error: unknown) => this.handleConnectionError(connection, error));
    });
    socket.on("close", () => void this.detach(connection));
    socket.on("error", () => socket.close());
  }

  async close(): Promise<void> {
    for (const connections of this.rooms.values()) {
      for (const connection of connections) connection.socket.close(1012, "server restarting");
    }
    const channels = [...this.rooms.keys()].map((roomId) => this.channelKey(roomId));
    if (channels.length > 0) await this.subscriber.unsubscribe(channels);
    this.rooms.clear();
  }

  async keyEpochChanged(roomId: string, keyEpoch: number): Promise<void> {
    await this.setCurrentKeyEpoch(roomId, keyEpoch);
    await this.publish(roomId, { type: "room.key-epoch", keyEpoch });
  }

  async setCurrentKeyEpoch(roomId: string, keyEpoch: number): Promise<void> {
    await this.command.set(this.keyEpochKey(roomId), keyEpoch.toString());
  }

  private async handle(connection: Connection, messageText: string): Promise<void> {
    this.consumeRateToken(connection);
    const message = parseClientMessage(messageText, this.config.maxEventBytes);
    switch (message.type) {
      case "presence.heartbeat":
        await this.refreshPresence(connection.identity);
        return;
      case "presence.focus":
        await this.updatePresence(connection.identity, message.terminalId);
        await this.publish(connection.identity.roomId, {
          type: "presence.focus",
          memberId: connection.identity.memberId,
          connectionId: connection.identity.connectionId,
          terminalId: message.terminalId,
        });
        return;
      case "history.replay":
        await this.replay(connection, message.afterSequence);
        return;
      case "control.acquire":
        await this.acquireControl(connection, message.terminalId);
        return;
      case "control.release":
        await this.releaseControl(connection, message.terminalId);
        return;
      case "encrypted.event":
        await this.publishEncrypted(connection, message);
    }
  }

  private consumeRateToken(connection: Connection): void {
    const now = Date.now();
    const limit = this.config.websocketMessagesPerSecond;
    const replenished = ((now - connection.rateUpdatedAt) / 1000) * limit;
    connection.rateTokens = Math.min(limit, connection.rateTokens + replenished);
    connection.rateUpdatedAt = now;
    if (connection.rateTokens < 1) throw new ProtocolError("message rate limit exceeded");
    connection.rateTokens -= 1;
  }

  private async replay(connection: Connection, afterSequence: number): Promise<void> {
    const entries = await this.command.xRange(
      this.historyKey(connection.identity.roomId),
      `(${afterSequence}-0`,
      "+",
      { COUNT: 1000 },
    );
    for (const entry of entries) {
      const event = entry.message.event;
      if (event && connection.socket.readyState === WebSocket.OPEN) connection.socket.send(event);
    }
    if (connection.socket.readyState === WebSocket.OPEN) {
      connection.socket.send(
        JSON.stringify({
          type: "history.complete",
          afterSequence,
          returned: entries.length,
          truncated: entries.length === 1000,
        }),
      );
    }
  }

  private async publishEncrypted(
    connection: Connection,
    message: Extract<ClientMessage, { type: "encrypted.event" }>,
  ): Promise<void> {
    if (message.roomId !== connection.identity.roomId) {
      throw new ProtocolError("event room does not match the connected room");
    }
    if (message.senderDeviceId !== connection.identity.deviceId) {
      throw new ProtocolError("event sender does not match the authenticated device");
    }
    if (message.keyEpoch !== connection.identity.keyEpoch) {
      throw new ProtocolError("event key epoch is not current for this connection");
    }
    const currentKeyEpoch = await this.command.get(
      this.keyEpochKey(connection.identity.roomId),
    );
    if (currentKeyEpoch !== connection.identity.keyEpoch.toString()) {
      throw new ProtocolError("room key epoch changed; reconnect to continue");
    }
    if (!canPublish(connection.identity.role, message.kind)) {
      throw new ProtocolError("room role cannot publish this event");
    }
    if (message.kind === "terminal.input") {
      const controller = await this.command.get(
        this.controlKey(connection.identity.roomId, message.terminalId!),
      );
      if (controller !== connection.identity.connectionId) {
        throw new ProtocolError("terminal control is not held by this connection");
      }
    }
    await this.refreshPresence(connection.identity);
    await this.publish(connection.identity.roomId, {
      ...message,
      memberId: connection.identity.memberId,
      connectionId: connection.identity.connectionId,
    });
  }

  private async acquireControl(connection: Connection, terminalId: string): Promise<void> {
    if (connection.identity.role === "viewer") {
      throw new ProtocolError("viewer cannot control a terminal");
    }
    const acquired = await this.command.eval(ACQUIRE_CONTROL_SCRIPT, {
      keys: [this.controlKey(connection.identity.roomId, terminalId)],
      arguments: [
        connection.identity.connectionId,
        (this.config.controlLeaseTtlSeconds * 1000).toString(),
      ],
    });
    await this.publish(connection.identity.roomId, {
      type: "control.state",
      terminalId,
      memberId: acquired === 1 ? connection.identity.memberId : null,
      connectionId: acquired === 1 ? connection.identity.connectionId : null,
      acquired: acquired === 1,
    });
  }

  private async releaseControl(connection: Connection, terminalId: string): Promise<void> {
    const released = await this.command.eval(RELEASE_CONTROL_SCRIPT, {
      keys: [this.controlKey(connection.identity.roomId, terminalId)],
      arguments: [connection.identity.connectionId],
    });
    if (released === 1) {
      await this.publish(connection.identity.roomId, {
        type: "control.state",
        terminalId,
        memberId: null,
        connectionId: null,
        acquired: false,
      });
    }
  }

  private async detach(connection: Connection): Promise<void> {
    const roomId = connection.identity.roomId;
    const connections = this.rooms.get(roomId);
    if (!connections?.delete(connection)) return;
    await this.command.del(this.presenceKey(connection.identity));
    await this.publish(roomId, {
      type: "presence.left",
      memberId: connection.identity.memberId,
      connectionId: connection.identity.connectionId,
    });
    if (connections.size === 0) {
      this.rooms.delete(roomId);
      await this.subscriber.unsubscribe(this.channelKey(roomId));
    }
  }

  private async updatePresence(identity: RealtimeTicket, terminalId: string | null): Promise<void> {
    await this.command.set(
      this.presenceKey(identity),
      JSON.stringify({ memberId: identity.memberId, connectionId: identity.connectionId, terminalId }),
      { EX: this.config.presenceTtlSeconds },
    );
  }

  private async refreshPresence(identity: RealtimeTicket): Promise<void> {
    await this.command.expire(this.presenceKey(identity), this.config.presenceTtlSeconds);
  }

  private async publish(roomId: string, event: Record<string, unknown>): Promise<void> {
    await this.command.eval(PUBLISH_SCRIPT, {
      keys: [this.sequenceKey(roomId), this.historyKey(roomId), this.channelKey(roomId)],
      arguments: [JSON.stringify(event), this.config.roomHistoryLimit.toString()],
    });
  }

  private broadcastLocal(roomId: string, message: string): void {
    const connections = this.rooms.get(roomId);
    if (!connections) return;
    let nextKeyEpoch: number | undefined;
    try {
      const event = JSON.parse(message) as { type?: unknown; keyEpoch?: unknown };
      if (
        event.type === "room.key-epoch" &&
        Number.isSafeInteger(event.keyEpoch) &&
        (event.keyEpoch as number) > 0
      ) {
        nextKeyEpoch = event.keyEpoch as number;
      }
    } catch {
      return;
    }
    for (const connection of connections) {
      if (connection.socket.readyState !== WebSocket.OPEN) continue;
      connection.socket.send(message);
      if (nextKeyEpoch !== undefined && connection.identity.keyEpoch !== nextKeyEpoch) {
        connection.socket.close(4003, "room key rotated");
      }
    }
  }

  private handleConnectionError(connection: Connection, error: unknown): void {
    if (error instanceof ProtocolError) {
      if (connection.socket.readyState === WebSocket.OPEN) {
        connection.socket.send(JSON.stringify({ type: "error", error: error.message }));
      }
      return;
    }
    connection.socket.close(1011, "message handling failed");
  }

  private sequenceKey(roomId: string): string {
    return `luma:room:{${roomId}}:sequence`;
  }

  private keyEpochKey(roomId: string): string {
    return `luma:room:{${roomId}}:key-epoch`;
  }

  private historyKey(roomId: string): string {
    return `luma:room:{${roomId}}:history`;
  }

  private channelKey(roomId: string): string {
    return `luma:room:{${roomId}}:events`;
  }

  private controlKey(roomId: string, terminalId: string): string {
    return `luma:room:{${roomId}}:control:${terminalId}`;
  }

  private presenceKey(identity: RealtimeTicket): string {
    return `luma:room:{${identity.roomId}}:presence:${identity.connectionId}`;
  }
}
