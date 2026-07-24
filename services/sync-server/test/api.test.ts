import { describe, expect, it } from "vitest";
import { createHandler } from "../src";
import type { Account, Env } from "../src/types";

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

class FakeDatabase {
  readonly accounts = new Map<string, Account>();

  prepare(query: string): D1PreparedStatement {
    let values: unknown[] = [];
    return {
      bind: (...bound: unknown[]) => {
        values = bound;
        return this.prepareBound(query, () => values);
      },
      run: () => this.run(query, values),
      first: () => this.first(query, values),
    } as unknown as D1PreparedStatement;
  }

  private prepareBound(
    query: string,
    values: () => unknown[],
  ): D1PreparedStatement {
    return {
      bind: (...bound: unknown[]) => {
        const next = values();
        next.splice(0, next.length, ...bound);
        return this.prepareBound(query, values);
      },
      run: () => this.run(query, values()),
      first: () => this.first(query, values()),
    } as unknown as D1PreparedStatement;
  }

  private async run(query: string, values: unknown[]): Promise<D1Result> {
    if (query.includes("INSERT OR IGNORE INTO accounts")) {
      const [subject, storageId, quota] = values as [string, string, number];
      if (!this.accounts.has(subject)) {
        this.accounts.set(subject, {
          subject,
          storage_id: storageId,
          quota_bytes: quota,
          used_bytes: 0,
          deleted_at: null,
        });
      }
    } else if (query.includes("SET used_bytes = ?2")) {
      const [subject, bytes] = values as [string, number];
      const account = this.accounts.get(subject);
      if (account) account.used_bytes = bytes;
    } else if (query.includes("deleted_at = unixepoch()")) {
      const [subject] = values as [string];
      const account = this.accounts.get(subject);
      if (account) {
        account.used_bytes = 0;
        account.deleted_at = Math.floor(Date.now() / 1000);
      }
    } else {
      throw new Error(`unexpected query: ${query}`);
    }
    return { success: true, meta: {} } as D1Result;
  }

  private async first<T>(query: string, values: unknown[]): Promise<T | null> {
    if (!query.includes("FROM accounts WHERE subject = ?1")) {
      throw new Error(`unexpected query: ${query}`);
    }
    return (this.accounts.get(values[0] as string) as T | undefined) ?? null;
  }
}

function createTestServer(quota = 1_024) {
  const bucket = new FakeBucket();
  const database = new FakeDatabase();
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
  return { bucket, database, env, context, handler, pending };
}

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
    expect(server.database.accounts.get("alice")?.storage_id).not.toBe(
      server.database.accounts.get("bob")?.storage_id,
    );
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
