import { createRemoteJWKSet, jwtVerify } from "jose";
import type { AuthenticatedUser, Env } from "./types";

const jwksSets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function authenticate(
  request: Request,
  env: Env,
): Promise<AuthenticatedUser> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    throw new HttpError(401, "missing bearer token");
  }

  const token = authorization.slice("Bearer ".length).trim();
  if (!token) {
    throw new HttpError(401, "missing bearer token");
  }

  let jwks = jwksSets.get(env.JWT_JWKS_URL);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(env.JWT_JWKS_URL));
    jwksSets.set(env.JWT_JWKS_URL, jwks);
  }

  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      algorithms: ["RS256", "ES256", "EdDSA"],
    });
    if (!payload.sub) {
      throw new HttpError(401, "token has no subject");
    }
    return { subject: payload.sub };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(401, "invalid bearer token");
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
