import { getOrCreateAccount, markDeleted } from "./accounts";
import { authenticate, HttpError } from "./auth";
import { json } from "./responses";
import { deleteAll, download, upload } from "./sync";
import type { AuthenticatedUser, Env } from "./types";

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
          return await download(env, account);
        }
        if (url.pathname === "/v1/sync" && request.method === "PUT") {
          return await upload(request, env, account, context);
        }
        if (url.pathname === "/v1/account" && request.method === "DELETE") {
          if (request.headers.get("x-confirm-delete") !== "delete-my-account") {
            throw new HttpError(400, "account deletion confirmation is required");
          }
          await deleteAll(env, account);
          await markDeleted(env, account.subject);
          return new Response(null, { status: 204 });
        }
        if (url.pathname === "/v1/account" && request.method === "GET") {
          return json(200, {
            quotaBytes: account.quota_bytes,
            usedBytes: account.used_bytes,
          });
        }
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

export default createHandler();
