import type { RedisClientType } from "redis";
import { randomBytes } from "node:crypto";
import type { Config } from "./config.js";
import type { RoomMembership } from "./database.js";

export interface RealtimeTicket extends RoomMembership {
  connectionId: string;
  instanceIssuedBy: string;
  deviceId: string;
  keyEpoch: number;
}

export class TicketStore {
  constructor(
    private readonly redis: RedisClientType,
    private readonly config: Config,
  ) {}

  async issue(
    membership: RoomMembership,
    deviceId: string,
    keyEpoch: number,
  ): Promise<{ ticket: string; expiresIn: number }> {
    const ticket = randomBytes(32).toString("base64url");
    const value: RealtimeTicket = {
      ...membership,
      deviceId,
      keyEpoch,
      connectionId: crypto.randomUUID(),
      instanceIssuedBy: this.config.instanceId,
    };
    await this.redis.set(this.key(ticket), JSON.stringify(value), { EX: this.config.ticketTtlSeconds });
    return { ticket, expiresIn: this.config.ticketTtlSeconds };
  }

  async consume(ticket: string): Promise<RealtimeTicket | null> {
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(ticket)) return null;
    const value = await this.redis.getDel(this.key(ticket));
    if (!value) return null;
    return JSON.parse(value) as RealtimeTicket;
  }

  private key(ticket: string): string {
    return `luma:realtime-ticket:${ticket}`;
  }
}
