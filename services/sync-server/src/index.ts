import { getOrCreateAccount, markDeleted } from "./accounts";
import { authenticate, HttpError } from "./auth";
import { json } from "./responses";
import { accountTarget, deleteAll, download, upload, vaultTarget } from "./sync";
import {
  bumpKeyEpoch,
  createInvite,
  createVault,
  getMemberKey,
  joinVault,
  listDevicesAwaitingKeys,
  listMemberships,
  putMemberKeys,
  registerDevice,
  removeMember,
  requireMembership,
  requireRole,
} from "./vaults";
import type { AuthenticatedUser, Env, VaultRole } from "./types";

export type Authenticator = (
  request: Request,
  env: Env,
) => Promise<AuthenticatedUser>;

export function createHandler(authenticator: Authenticator = authenticate) {
  return {
    async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
      try {
        const url = new URL(request.url);
        if (url.pathname === "/health" && request.method === "GET") {
          return json(200, { status: "ok" });
        }
        if (url.pathname === "/v1/client-config" && request.method === "GET") {
          return json(200, {
            issuer: env.JWT_ISSUER,
            audience: env.JWT_AUDIENCE,
            clientId: env.OIDC_CLIENT_ID,
            deviceAuthorizationEndpoint: env.OIDC_DEVICE_AUTHORIZATION_ENDPOINT,
            tokenEndpoint: env.OIDC_TOKEN_ENDPOINT,
          });
        }
        if (!url.pathname.startsWith("/v1/")) {
          return json(404, { error: "not found" });
        }

        const user = await authenticator(request, env);
        if (env.RATE_LIMITER) {
          const allowed = await env.RATE_LIMITER.limit({ key: user.subject });
          if (!allowed.success) {
            throw new HttpError(429, "too many requests");
          }
        }
        const account = await getOrCreateAccount(env, user.subject);

        if (url.pathname === "/v1/sync" && request.method === "GET") {
          return await download(env, accountTarget(account));
        }
        if (url.pathname === "/v1/sync" && request.method === "PUT") {
          return await upload(request, env, accountTarget(account), context);
        }
        if (url.pathname === "/v1/account" && request.method === "DELETE") {
          if (request.headers.get("x-confirm-delete") !== "delete-my-account") {
            throw new HttpError(400, "account deletion confirmation is required");
          }
          await deleteAll(env, accountTarget(account));
          await markDeleted(env, account.subject);
          return new Response(null, { status: 204 });
        }
        if (url.pathname === "/v1/account" && request.method === "GET") {
          return json(200, {
            quotaBytes: account.quota_bytes,
            usedBytes: account.used_bytes,
          });
        }

        const vaultResponse = await routeVaults(request, env, context, url, user.subject);
        if (vaultResponse) return vaultResponse;

        return json(404, { error: "not found" });
      } catch (error) {
        if (error instanceof HttpError) {
          return json(error.status, { error: error.message });
        }
        console.error("request failed", {
          method: request.method,
          pathname: new URL(request.url).pathname,
          error: error instanceof Error ? error.message : "unknown error",
        });
        return json(500, { error: "internal server error" });
      }
    },
  };
}

/** Returns null when the path is not a vault route, so the caller can 404. */
async function routeVaults(
  request: Request,
  env: Env,
  context: ExecutionContext,
  url: URL,
  subject: string,
): Promise<Response | null> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments[0] !== "v1" || segments[1] !== "vaults") return null;
  const method = request.method;

  if (segments.length === 2) {
    if (method === "POST") {
      const vault = await createVault(env, subject);
      return json(201, { id: vault.id, role: "owner", keyEpoch: vault.key_epoch });
    }
    if (method === "GET") {
      return json(200, { vaults: await listMemberships(env, subject) });
    }
    return null;
  }

  // `join` redeems an invite, so it is the one vault route reachable by a
  // non-member and must be matched before membership is resolved.
  if (segments.length === 3 && segments[2] === "join" && method === "POST") {
    const body = await readJson(request);
    return json(200, await joinVault(env, subject, body.secret as string));
  }
  if (segments.length === 3 && segments[2] === "devices" && method === "POST") {
    const body = await readJson(request);
    await registerDevice(env, subject, body.deviceId, body.publicKey);
    return new Response(null, { status: 204 });
  }

  const vaultId = segments[2];
  if (!vaultId) return null;
  const membership = await requireMembership(env, vaultId, subject);
  const tail = segments.slice(3);

  if (tail.length === 1 && tail[0] === "sync") {
    if (method === "GET") {
      return await download(env, await vaultTarget(env, membership.vault));
    }
    if (method === "PUT") {
      requireRole(membership, "owner", "writer");
      return await upload(request, env, await vaultTarget(env, membership.vault), context);
    }
    return null;
  }

  if (tail.length === 1 && tail[0] === "key" && method === "GET") {
    const deviceId = url.searchParams.get("deviceId");
    if (!deviceId) throw new HttpError(400, "deviceId is required");
    const key = await getMemberKey(env, membership.vault, subject, deviceId);
    if (!key) {
      throw new HttpError(404, "no key has been sealed to this device yet");
    }
    return json(200, key);
  }

  if (tail.length === 1 && tail[0] === "keys") {
    requireRole(membership, "owner", "writer");
    if (method === "GET") {
      return json(200, { devices: await listDevicesAwaitingKeys(env, membership.vault) });
    }
    if (method === "POST") {
      const body = await readJson(request);
      const written = await putMemberKeys(env, membership.vault, subject, body.keys);
      return json(200, { written, keyEpoch: membership.vault.key_epoch });
    }
    return null;
  }

  if (tail.length === 1 && tail[0] === "invites" && method === "POST") {
    requireRole(membership, "owner");
    const body = await readJson(request);
    const invite = await createInvite(
      env,
      membership.vault,
      subject,
      (body.role as VaultRole) ?? "writer",
    );
    return json(201, invite);
  }

  if (tail.length === 1 && tail[0] === "key-epoch" && method === "POST") {
    requireRole(membership, "owner");
    return json(200, { keyEpoch: await bumpKeyEpoch(env, membership.vault) });
  }

  if (tail.length === 2 && tail[0] === "members" && method === "DELETE") {
    requireRole(membership, "owner");
    await removeMember(env, membership.vault, decodeURIComponent(tail[1]));
    return new Response(null, { status: 204 });
  }

  return null;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new HttpError(400, "request body must be JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

export default createHandler();
