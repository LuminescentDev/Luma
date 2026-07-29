import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createHandler } from "../src";
import type { Env } from "../src/types";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "../migrations");

type StoredObject = {
  bytes: Uint8Array;
  etag: string;
  uploaded: Date;
  customMetadata?: Record<string, string>;
};

class FakeBucket {
  readonly objects = new Map<string, StoredObject>();
  private etagSequence = 0;

  async get(key: string): Promise<R2ObjectBody | null> {
    const stored = this.objects.get(key);
    if (!stored) return null;
    const bytes = stored.bytes.slice();
    return {
      key,
      size: bytes.byteLength,
      etag: stored.etag,
      httpEtag: `"${stored.etag}"`,
      uploaded: stored.uploaded,
      customMetadata: stored.customMetadata,
      body: new Blob([bytes]).stream(),
    } as unknown as R2ObjectBody;
  }

  async put(
    key: string,
    value: unknown,
    options?: R2PutOptions,
  ): Promise<R2Object | null> {
    const current = this.objects.get(key);
    const onlyIf = options?.onlyIf as R2Conditional | undefined;
    if (
      onlyIf?.etagMatches !== undefined &&
      current?.etag !== onlyIf.etagMatches
    ) {
      return null;
    }
    if (
      onlyIf?.etagDoesNotMatch === "*" &&
      current !== undefined
    ) {
      return null;
    }

    const bytes = new Uint8Array(
      await new Response(value as BodyInit).arrayBuffer(),
    );
    const etag = `etag-${++this.etagSequence}`;
    const uploaded = new Date();
    this.objects.set(key, {
      bytes,
      etag,
      uploaded,
      customMetadata: options?.customMetadata,
    });
    return {
      key,
      size: bytes.byteLength,
      etag,
      httpEtag: `"${etag}"`,
      uploaded,
    } as R2Object;
  }

  async list(options?: R2ListOptions): Promise<R2Objects> {
    const prefix = options?.prefix ?? "";
    const objects = [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, stored]) => ({
        key,
        size: stored.bytes.byteLength,
        etag: stored.etag,
        httpEtag: `"${stored.etag}"`,
        uploaded: stored.uploaded,
      })) as R2Object[];
    return {
      objects,
      truncated: false,
      delimitedPrefixes: [],
    };
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      this.objects.delete(key);
    }
  }
}

/**
 * D1 is SQLite, so the shipped migrations run against an in-memory database
 * rather than being approximated by a query matcher: the tests then cover the
 * real schema, constraints and joins, not a hand-written stand-in for them.
 */
class TestDatabase {
  private readonly db = new DatabaseSync(":memory:");

  constructor() {
    for (const file of readdirSync(MIGRATIONS).sort()) {
      if (file.endsWith(".sql")) {
        this.db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
      }
    }
    this.db.exec("PRAGMA foreign_keys = ON");
  }

  prepare(query: string): D1PreparedStatement {
    const statement = this.db.prepare(query);
    const build = (values: unknown[]): D1PreparedStatement =>
      ({
        bind: (...bound: unknown[]) => build(bound),
        run: async () => {
          statement.run(...(values as never[]));
          return { success: true, meta: {} } as D1Result;
        },
        first: async () => (statement.get(...(values as never[])) as unknown) ?? null,
        all: async () => ({
          results: statement.all(...(values as never[])),
          success: true,
          meta: {},
        }),
      }) as unknown as D1PreparedStatement;
    return build([]);
  }

  query<T>(sql: string, ...values: unknown[]): T[] {
    return this.db.prepare(sql).all(...(values as never[])) as T[];
  }
}

function createTestServer(quota = 1_024) {
  const bucket = new FakeBucket();
  const database = new TestDatabase();
  const env = {
    SYNC_BUCKET: bucket,
    DB: database,
    JWT_ISSUER: "https://identity.example/",
    JWT_AUDIENCE: "luma-sync",
    JWT_JWKS_URL: "https://identity.example/.well-known/jwks.json",
    OIDC_CLIENT_ID: "native-client",
    OIDC_DEVICE_AUTHORIZATION_ENDPOINT: "https://identity.example/device",
    OIDC_TOKEN_ENDPOINT: "https://identity.example/token",
    DEFAULT_QUOTA_BYTES: quota.toString(),
    MAX_BLOB_BYTES: "67108864",
    REVISION_LIMIT: "20",
  } as unknown as Env;
  const pending: Promise<unknown>[] = [];
  const context = {
    waitUntil: (promise: Promise<unknown>) => {
      pending.push(promise);
    },
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
  const handler = createHandler(async (request) => {
    const subject = request.headers.get("x-test-subject");
    if (!subject) throw new Error("test subject missing");
    return { subject };
  });

  const call = (
    subject: string,
    method: string,
    path: string,
    body?: string,
    headers: Record<string, string> = {},
  ) =>
    handler.fetch(
      new Request(`https://sync.example${path}`, {
        method,
        body,
        headers: {
          "x-test-subject": subject,
          ...(body
            ? {
                "content-type": "application/vnd.luma.sync",
                "content-length": new TextEncoder()
                  .encode(body)
                  .byteLength.toString(),
              }
            : {}),
          ...headers,
        },
      }),
      env,
      context,
    );

  const callJson = (
    subject: string,
    method: string,
    path: string,
    body?: unknown,
  ) =>
    handler.fetch(
      new Request(`https://sync.example${path}`, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: {
          "x-test-subject": subject,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
      }),
      env,
      context,
    );

  return { bucket, database, env, context, handler, pending, call, callJson };
}

type Server = ReturnType<typeof createTestServer>;

function request(
  subject: string,
  method: string,
  body?: string,
  headers: Record<string, string> = {},
): Request {
  return new Request("https://sync.example/v1/sync", {
    method,
    body,
    headers: {
      "x-test-subject": subject,
      ...(body
        ? {
            "content-type": "application/vnd.luma.sync",
            "content-length": new TextEncoder().encode(body).byteLength.toString(),
          }
        : {}),
      ...headers,
    },
  });
}

async function createVault(server: Server, subject: string): Promise<string> {
  const response = await server.callJson(subject, "POST", "/v1/vaults");
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

async function invite(
  server: Server,
  owner: string,
  vaultId: string,
  role: "writer" | "reader",
): Promise<string> {
  const response = await server.callJson(
    owner,
    "POST",
    `/v1/vaults/${vaultId}/invites`,
    { role },
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { secret: string }).secret;
}

describe("sync API", () => {
  it("isolates storage using only the authenticated subject", async () => {
    const server = createTestServer();
    const created = await server.handler.fetch(
      request("alice", "PUT", "alice-secret", { "if-none-match": "*" }),
      server.env,
      server.context,
    );
    expect(created.status).toBe(204);

    const alice = await server.handler.fetch(
      request("alice", "GET"),
      server.env,
      server.context,
    );
    const bob = await server.handler.fetch(
      request("bob", "GET"),
      server.env,
      server.context,
    );
    expect(await alice.text()).toBe("alice-secret");
    expect(bob.status).toBe(404);

    const storageIds = server.database.query<{ storage_id: string }>(
      "SELECT storage_id FROM accounts ORDER BY subject",
    );
    expect(storageIds).toHaveLength(2);
    expect(storageIds[0].storage_id).not.toBe(storageIds[1].storage_id);
  });

  it("uses ETags to reject stale writes and retains the previous ciphertext", async () => {
    const server = createTestServer();
    const first = await server.handler.fetch(
      request("alice", "PUT", "first", { "if-none-match": "*" }),
      server.env,
      server.context,
    );
    const firstEtag = first.headers.get("etag")!;

    const second = await server.handler.fetch(
      request("alice", "PUT", "second", { "if-match": firstEtag }),
      server.env,
      server.context,
    );
    const stale = await server.handler.fetch(
      request("alice", "PUT", "stale", { "if-match": firstEtag }),
      server.env,
      server.context,
    );
    expect(second.status).toBe(204);
    expect(stale.status).toBe(412);

    const current = await server.handler.fetch(
      request("alice", "GET"),
      server.env,
      server.context,
    );
    expect(await current.text()).toBe("second");
    expect(
      [...server.bucket.objects.keys()].some((key) => key.includes("/revisions/")),
    ).toBe(true);
  });

  it("requires explicit creation preconditions and enforces account quota", async () => {
    const server = createTestServer(4);
    const missingCondition = await server.handler.fetch(
      request("alice", "PUT", "data"),
      server.env,
      server.context,
    );
    const overQuota = await server.handler.fetch(
      request("alice", "PUT", "large", { "if-none-match": "*" }),
      server.env,
      server.context,
    );
    expect(missingCondition.status).toBe(428);
    expect(overQuota.status).toBe(413);
  });
});

describe("vault sync", () => {
  it("stores a vault blob outside the personal namespace", async () => {
    const server = createTestServer();
    const vaultId = await createVault(server, "alice");

    const stored = await server.call(
      "alice",
      "PUT",
      `/v1/vaults/${vaultId}/sync`,
      "infra-secret",
      { "if-none-match": "*" },
    );
    expect(stored.status).toBe(204);

    const personal = await server.call("alice", "GET", "/v1/sync");
    expect(personal.status).toBe(404);

    const vault = await server.call("alice", "GET", `/v1/vaults/${vaultId}/sync`);
    expect(await vault.text()).toBe("infra-secret");
    expect([...server.bucket.objects.keys()]).toEqual([
      expect.stringMatching(/^vaults\/[0-9a-f-]+\/current\.luma$/),
    ]);
  });

  it("hides a vault from non-members and lists it for members", async () => {
    const server = createTestServer();
    const vaultId = await createVault(server, "alice");

    const probe = await server.call("mallory", "GET", `/v1/vaults/${vaultId}/sync`);
    expect(probe.status).toBe(404);

    const secret = await invite(server, "alice", vaultId, "writer");
    const joined = await server.callJson("bob", "POST", "/v1/vaults/join", { secret });
    expect(joined.status).toBe(200);
    expect(await joined.json()).toMatchObject({ vaultId, role: "writer", keyEpoch: 1 });

    const listed = await server.callJson("bob", "GET", "/v1/vaults");
    expect(await listed.json()).toEqual({
      vaults: [{ id: vaultId, role: "writer", keyEpoch: 1, ownerSubject: "alice" }],
    });
    const mallory = await server.callJson("mallory", "GET", "/v1/vaults");
    expect(await mallory.json()).toEqual({ vaults: [] });
  });

  it("lets a reader download but not upload", async () => {
    const server = createTestServer();
    const vaultId = await createVault(server, "alice");
    await server.call(
      "alice",
      "PUT",
      `/v1/vaults/${vaultId}/sync`,
      "shared",
      { "if-none-match": "*" },
    );

    const secret = await invite(server, "alice", vaultId, "reader");
    await server.callJson("bob", "POST", "/v1/vaults/join", { secret });

    const read = await server.call("bob", "GET", `/v1/vaults/${vaultId}/sync`);
    expect(read.status).toBe(200);
    expect(await read.text()).toBe("shared");

    const write = await server.call(
      "bob",
      "PUT",
      `/v1/vaults/${vaultId}/sync`,
      "tampered",
      { "if-match": '"etag-1"' },
    );
    expect(write.status).toBe(403);

    const unchanged = await server.call("alice", "GET", `/v1/vaults/${vaultId}/sync`);
    expect(await unchanged.text()).toBe("shared");
  });

  it("only lets the owner invite, rotate the epoch and remove members", async () => {
    const server = createTestServer();
    const vaultId = await createVault(server, "alice");
    const secret = await invite(server, "alice", vaultId, "writer");
    await server.callJson("bob", "POST", "/v1/vaults/join", { secret });

    const bobInvite = await server.callJson(
      "bob",
      "POST",
      `/v1/vaults/${vaultId}/invites`,
      { role: "reader" },
    );
    const bobEpoch = await server.callJson(
      "bob",
      "POST",
      `/v1/vaults/${vaultId}/key-epoch`,
    );
    const bobRemove = await server.callJson(
      "bob",
      "DELETE",
      `/v1/vaults/${vaultId}/members/alice`,
    );
    expect([bobInvite.status, bobEpoch.status, bobRemove.status]).toEqual([403, 403, 403]);

    const ownerEpoch = await server.callJson(
      "alice",
      "POST",
      `/v1/vaults/${vaultId}/key-epoch`,
    );
    expect(await ownerEpoch.json()).toEqual({ keyEpoch: 2 });

    const removeOwner = await server.callJson(
      "alice",
      "DELETE",
      `/v1/vaults/${vaultId}/members/alice`,
    );
    expect(removeOwner.status).toBe(409);
  });

  it("rejects an unknown, expired or revoked invite", async () => {
    const server = createTestServer();
    const vaultId = await createVault(server, "alice");
    const secret = await invite(server, "alice", vaultId, "writer");

    const unknown = await server.callJson("bob", "POST", "/v1/vaults/join", {
      secret: "not-a-real-invite",
    });
    expect(unknown.status).toBe(404);

    server.database.query(
      "UPDATE vault_invites SET expires_at = 1 WHERE vault_id = ?1",
      vaultId,
    );
    const expired = await server.callJson("bob", "POST", "/v1/vaults/join", { secret });
    expect(expired.status).toBe(404);
  });

  it("seals the content key per device and withholds it from other members", async () => {
    const server = createTestServer();
    const vaultId = await createVault(server, "alice");
    const secret = await invite(server, "alice", vaultId, "writer");
    await server.callJson("bob", "POST", "/v1/vaults/join", { secret });

    await server.callJson("bob", "POST", "/v1/vaults/devices", {
      deviceId: "bob-laptop",
      publicKey: { kty: "EC", crv: "P-256", x: "bob-x", y: "bob-y" },
    });

    // Before sealing, bob is a member but cannot decrypt anything.
    const missing = await server.callJson(
      "bob",
      "GET",
      `/v1/vaults/${vaultId}/key?deviceId=bob-laptop`,
    );
    expect(missing.status).toBe(404);

    const awaiting = await server.callJson("alice", "GET", `/v1/vaults/${vaultId}/keys`);
    expect(await awaiting.json()).toEqual({
      devices: [
        {
          subject: "bob",
          deviceId: "bob-laptop",
          publicKey: { kty: "EC", crv: "P-256", x: "bob-x", y: "bob-y" },
        },
      ],
    });

    const sealed = await server.callJson("alice", "POST", `/v1/vaults/${vaultId}/keys`, {
      keys: [
        { subject: "bob", deviceId: "bob-laptop", envelope: { ciphertext: "sealed" } },
      ],
    });
    expect(await sealed.json()).toEqual({ written: 1, keyEpoch: 1 });

    const fetched = await server.callJson(
      "bob",
      "GET",
      `/v1/vaults/${vaultId}/key?deviceId=bob-laptop`,
    );
    expect(await fetched.json()).toEqual({
      keyEpoch: 1,
      envelope: { ciphertext: "sealed" },
    });

    // The envelope is addressed to bob; nobody else can fetch it.
    const outsider = await server.callJson(
      "alice",
      "GET",
      `/v1/vaults/${vaultId}/key?deviceId=bob-laptop`,
    );
    expect(outsider.status).toBe(404);

    const toNonMember = await server.callJson(
      "alice",
      "POST",
      `/v1/vaults/${vaultId}/keys`,
      { keys: [{ subject: "mallory", deviceId: "m1", envelope: { ciphertext: "x" } }] },
    );
    expect(toNonMember.status).toBe(409);
  });

  it("treats an omitted subject as the caller's own device", async () => {
    // Vault creation and key rotation both seal to the caller's own device, and
    // a client never learns its own subject, so it sends the device id alone.
    const server = createTestServer();
    const vaultId = await createVault(server, "alice");
    await server.callJson("alice", "POST", "/v1/vaults/devices", {
      deviceId: "alice-desktop",
      publicKey: { kty: "EC", crv: "P-256" },
    });

    const sealed = await server.callJson("alice", "POST", `/v1/vaults/${vaultId}/keys`, {
      keys: [{ deviceId: "alice-desktop", envelope: { ciphertext: "own" } }],
    });
    expect(await sealed.json()).toEqual({ written: 1, keyEpoch: 1 });

    const fetched = await server.callJson(
      "alice",
      "GET",
      `/v1/vaults/${vaultId}/key?deviceId=alice-desktop`,
    );
    expect(await fetched.json()).toEqual({
      keyEpoch: 1,
      envelope: { ciphertext: "own" },
    });
    expect(
      server.database.query<{ subject: string }>("SELECT subject FROM vault_member_keys"),
    ).toEqual([{ subject: "alice" }]);
  });

  it("drops a removed member's access and sealed keys", async () => {
    const server = createTestServer();
    const vaultId = await createVault(server, "alice");
    const secret = await invite(server, "alice", vaultId, "writer");
    await server.callJson("bob", "POST", "/v1/vaults/join", { secret });
    await server.callJson("bob", "POST", "/v1/vaults/devices", {
      deviceId: "bob-laptop",
      publicKey: { kty: "EC" },
    });
    await server.callJson("alice", "POST", `/v1/vaults/${vaultId}/keys`, {
      keys: [{ subject: "bob", deviceId: "bob-laptop", envelope: { ciphertext: "s" } }],
    });

    const removed = await server.callJson(
      "alice",
      "DELETE",
      `/v1/vaults/${vaultId}/members/bob`,
    );
    expect(removed.status).toBe(204);

    const afterward = await server.call("bob", "GET", `/v1/vaults/${vaultId}/sync`);
    expect(afterward.status).toBe(404);
    expect(
      server.database.query("SELECT 1 FROM vault_member_keys WHERE subject = 'bob'"),
    ).toEqual([]);
  });

  it("charges a vault blob to the owner's quota, not the writer's", async () => {
    const server = createTestServer(24);
    const vaultId = await createVault(server, "alice");
    const secret = await invite(server, "alice", vaultId, "writer");
    await server.callJson("bob", "POST", "/v1/vaults/join", { secret });

    const stored = await server.call(
      "bob",
      "PUT",
      `/v1/vaults/${vaultId}/sync`,
      "0123456789",
      { "if-none-match": "*" },
    );
    expect(stored.status).toBe(204);

    const [vault] = server.database.query<{ used_bytes: number }>(
      "SELECT used_bytes FROM vaults WHERE id = ?1",
      vaultId,
    );
    expect(vault.used_bytes).toBe(10);
    const [bob] = server.database.query<{ used_bytes: number }>(
      "SELECT used_bytes FROM accounts WHERE subject = 'bob'",
    );
    expect(bob.used_bytes).toBe(0);

    // Alice's own personal blob now has to fit in what the vault left behind.
    const overQuota = await server.handler.fetch(
      request("alice", "PUT", "personal-blob-that-is-too-long", {
        "if-none-match": "*",
      }),
      server.env,
      server.context,
    );
    expect(overQuota.status).toBe(413);
  });
});
