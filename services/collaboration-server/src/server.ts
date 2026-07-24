import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createClient } from "redis";
import { WebSocketServer } from "ws";
import {
  CollaborationCryptoError,
  importDevicePublicKey,
  parseDevicePublicKey,
  parseRoomKeyEnvelope,
  type RoomKeyEnvelope,
} from "@luma/collaboration-encryption";
import { Authenticator, HttpError } from "./auth.js";
import { loadConfig } from "./config.js";
import { Database } from "./database.js";
import { RoomRouter } from "./roomRouter.js";
import { SNAPSHOT_CONTENT_TYPE, SnapshotStorage } from "./storage.js";
import { TicketStore } from "./tickets.js";
import type { RoomRole } from "@luma/collaboration-protocol";

const config = loadConfig();
const database = new Database(config.databaseUrl);
const redis = createClient({ url: config.redisUrl });
const subscriber = redis.duplicate();
const authenticator = new Authenticator(config);
const tickets = new TicketStore(redis, config);
const snapshots = new SnapshotStorage(config);
const roomRouter = new RoomRouter(redis, subscriber, config);
const webSockets = new WebSocketServer({ noServer: true, maxPayload: config.maxEventBytes });

redis.on("error", (error) => console.error("redis command connection error", error.message));
subscriber.on("error", (error) => console.error("redis subscriber connection error", error.message));
await Promise.all([redis.connect(), subscriber.connect()]);

const server = createServer((request, response) => {
  void handleRequest(request, response).catch((error: unknown) => handleRequestError(request, response, error));
});

server.on("upgrade", (request, socket, head) => {
  void (async () => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/v1/realtime") throw new HttpError(404, "not found");
    const ticketValue = url.searchParams.get("ticket");
    const identity = ticketValue ? await tickets.consume(ticketValue) : null;
    if (!identity) throw new HttpError(401, "invalid or expired realtime ticket");
    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      void roomRouter.attach(webSocket, identity).catch(() => {
        webSocket.close(1011, "room connection failed");
      });
    });
  })().catch((error: unknown) => {
    const status = error instanceof HttpError ? error.status : 500;
    socket.end(`HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : "Error"}\r\nConnection: close\r\n\r\n`);
  });
});

server.listen(config.port, config.host, () => {
  console.log(`collaboration server ${config.instanceId} listening on ${config.host}:${config.port}`);
});

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://localhost");
  response.setHeader("x-luma-instance", config.instanceId);

  if (method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { status: "ok", instanceId: config.instanceId });
    return;
  }
  if (method === "GET" && url.pathname === "/ready") {
    await Promise.all([database.ping(), redis.ping()]);
    sendJson(response, 200, { status: "ready", instanceId: config.instanceId });
    return;
  }
  if (method === "GET" && url.pathname === "/v1/client-config") {
    sendJson(response, 200, {
      issuer: config.jwtIssuer,
      audience: config.jwtAudience,
      clientId: config.oidcClientId,
      deviceAuthorizationEndpoint: config.oidcDeviceAuthorizationEndpoint,
      tokenEndpoint: config.oidcTokenEndpoint,
    });
    return;
  }
  if (!url.pathname.startsWith("/v1/")) throw new HttpError(404, "not found");

  const user = await authenticator.authenticate(request.headers);
  await enforceHttpRateLimit(user.subject);
  await database.ensureAccount(user.subject);

  if (method === "POST" && url.pathname === "/v1/devices") {
    const body = await readJson(request, 32 * 1024);
    const deviceId = validatedUuid(body.deviceId, "device id");
    try {
      const publicKey = parseDevicePublicKey(body.publicKey);
      await importDevicePublicKey(publicKey);
      await database.registerDevice(user.subject, deviceId, publicKey);
    } catch (error) {
      if (error instanceof CollaborationCryptoError) throw new HttpError(400, error.message);
      throw error;
    }
    response.writeHead(204, securityHeaders());
    response.end();
    return;
  }
  if (method === "GET" && url.pathname === "/v1/devices") {
    sendJson(response, 200, { devices: await database.devices(user.subject) });
    return;
  }

  if (method === "POST" && url.pathname === "/v1/rooms") {
    const body = await readJson(request, 128 * 1024);
    const roomId = validatedUuid(body.roomId, "room id");
    const deviceKeys = parseDeviceKeys(body.deviceKeys, roomId, 1);
    const room = await database.createRoom(user.subject, roomId, deviceKeys);
    sendJson(response, 201, room);
    return;
  }

  const membersMatch = url.pathname.match(/^\/v1\/rooms\/([0-9a-f-]+)\/members$/i);
  if (method === "POST" && membersMatch) {
    const roomId = validatedRoomId(membersMatch[1]);
    const body = await readJson(request, 128 * 1024);
    if (typeof body.subject !== "string" || body.subject.length < 1 || body.subject.length > 512) {
      throw new HttpError(400, "subject is invalid");
    }
    if (body.role !== "controller" && body.role !== "viewer") {
      throw new HttpError(400, "role must be controller or viewer");
    }
    const member = await database.addMember(
      roomId,
      user.subject,
      body.subject,
      body.role as Exclude<RoomRole, "owner">,
      parseDeviceKeys(body.deviceKeys, roomId),
    );
    sendJson(response, 201, member);
    return;
  }

  const roomMatch = url.pathname.match(/^\/v1\/rooms\/([0-9a-f-]+)$/i);
  if (method === "GET" && roomMatch) {
    const deviceId = validatedUuid(url.searchParams.get("deviceId"), "device id");
    const details = await database.roomDetails(
      validatedRoomId(roomMatch[1]),
      user.subject,
      deviceId,
    );
    sendJson(response, 200, {
      roomId: details.roomId,
      memberId: details.memberId,
      role: details.role,
      keyEpoch: details.keyEpoch,
      keyEnvelope: details.keyEnvelope,
    });
    return;
  }

  const ticketMatch = url.pathname.match(/^\/v1\/rooms\/([0-9a-f-]+)\/realtime-ticket$/i);
  if (method === "POST" && ticketMatch) {
    const roomId = validatedRoomId(ticketMatch[1]);
    const body = await readJson(request, 16 * 1024);
    const deviceId = validatedUuid(body.deviceId, "device id");
    const details = await database.roomDetails(roomId, user.subject, deviceId);
    const { keyEnvelope: _, keyEpoch, ...membership } = details;
    await roomRouter.setCurrentKeyEpoch(roomId, keyEpoch);
    sendJson(response, 201, await tickets.issue(membership, deviceId, keyEpoch));
    return;
  }

  const keyEpochMatch = url.pathname.match(/^\/v1\/rooms\/([0-9a-f-]+)\/key-epoch$/i);
  if (method === "PUT" && keyEpochMatch) {
    const roomId = validatedRoomId(keyEpochMatch[1]);
    const body = await readJson(request, 512 * 1024);
    if (!Number.isSafeInteger(body.keyEpoch) || (body.keyEpoch as number) < 2) {
      throw new HttpError(400, "keyEpoch must be an integer greater than one");
    }
    const keyEpoch = body.keyEpoch as number;
    const deviceKeys = parseDeviceKeys(body.deviceKeys, roomId, keyEpoch);
    await database.rotateRoomKey(roomId, user.subject, keyEpoch, deviceKeys);
    await roomRouter.keyEpochChanged(roomId, keyEpoch);
    response.writeHead(204, securityHeaders());
    response.end();
    return;
  }

  const snapshotMatch = url.pathname.match(/^\/v1\/rooms\/([0-9a-f-]+)\/snapshot$/i);
  if (snapshotMatch) {
    const roomId = validatedRoomId(snapshotMatch[1]);
    const membership = await database.membership(roomId, user.subject);
    if (method === "GET") {
      const object = await snapshots.get(roomId);
      const bytes = object.Body ? Buffer.from(await object.Body.transformToByteArray()) : Buffer.alloc(0);
      response.writeHead(200, {
        ...securityHeaders(),
        "content-type": object.ContentType ?? SNAPSHOT_CONTENT_TYPE,
        "content-length": bytes.byteLength,
        etag: object.ETag ?? "",
      });
      response.end(bytes);
      return;
    }
    if (method === "PUT") {
      if (membership.role !== "owner") throw new HttpError(403, "only the room owner can update snapshots");
      if (request.headers["content-type"]?.split(";", 1)[0] !== SNAPSHOT_CONTENT_TYPE) {
        throw new HttpError(415, `content type must be ${SNAPSHOT_CONTENT_TYPE}`);
      }
      const ifMatch = singleHeader(request.headers["if-match"]);
      const ifNoneMatch = singleHeader(request.headers["if-none-match"]);
      if (!ifMatch && ifNoneMatch !== "*") {
        throw new HttpError(428, "If-Match or If-None-Match: * is required");
      }
      const bytes = await readBytes(request, config.maxSnapshotBytes);
      const etag = await snapshots.put(roomId, bytes, ifMatch, ifNoneMatch === "*");
      response.writeHead(204, { ...securityHeaders(), etag });
      response.end();
      return;
    }
  }
  throw new HttpError(404, "not found");
}

async function enforceHttpRateLimit(subject: string): Promise<void> {
  const window = Math.floor(Date.now() / 60_000);
  const key = `luma:http-rate:${window}:${subject}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 70);
  if (count > config.httpRequestsPerMinute) throw new HttpError(429, "too many requests");
}

async function readJson(request: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const bytes = await readBytes(request, maxBytes);
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "request body must be a JSON object");
  }
}

async function readBytes(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.byteLength;
    if (length > maxBytes) throw new HttpError(413, "request body is too large");
    chunks.push(bytes);
  }
  if (length === 0) throw new HttpError(400, "request body is required");
  return Buffer.concat(chunks, length);
}

function parseDeviceKeys(
  value: unknown,
  roomId: string,
  expectedKeyEpoch?: number,
): Array<{ deviceId: string; envelope: RoomKeyEnvelope }> {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    throw new HttpError(400, "deviceKeys must contain one envelope per active device");
  }
  try {
    return value.map((entry) => {
      if (!isRecord(entry)) throw new HttpError(400, "device key entry is invalid");
      const deviceId = validatedUuid(entry.deviceId, "device id");
      const envelope = parseRoomKeyEnvelope(entry.envelope);
      if (
        envelope.roomId !== roomId ||
        envelope.recipientDeviceId !== deviceId ||
        (expectedKeyEpoch !== undefined && envelope.keyEpoch !== expectedKeyEpoch)
      ) {
        throw new HttpError(400, "room key envelope context is invalid");
      }
      return { deviceId, envelope };
    });
  } catch (error) {
    if (error instanceof CollaborationCryptoError) throw new HttpError(400, error.message);
    throw error;
  }
}

function validatedRoomId(value: string | undefined): string {
  return validatedUuid(value, "room id");
}

function validatedUuid(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new HttpError(400, `${name} is invalid`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function sendJson(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    ...securityHeaders(),
    "content-type": "application/json; charset=utf-8",
    "content-length": bytes.byteLength,
  });
  response.end(bytes);
}

function securityHeaders(): Record<string, string> {
  return {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
}

function handleRequestError(request: IncomingMessage, response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  if (error instanceof HttpError) {
    sendJson(response, error.status, { error: error.message });
    return;
  }
  const statusCode = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  if (statusCode === 404) {
    sendJson(response, 404, { error: "snapshot not found" });
    return;
  }
  if (statusCode === 412) {
    sendJson(response, 412, { error: "snapshot changed since it was downloaded" });
    return;
  }
  if ((error as { code?: string })?.code === "23505") {
    sendJson(response, 409, { error: "resource already exists" });
    return;
  }
  console.error("request failed", { method: request.method, url: request.url, error: error instanceof Error ? error.message : "unknown error" });
  sendJson(response, 500, { error: "internal server error" });
}

async function shutdown(signal: string): Promise<void> {
  console.log(`received ${signal}; shutting down ${config.instanceId}`);
  server.close();
  await roomRouter.close();
  await Promise.all([subscriber.quit(), redis.quit(), database.close()]);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
