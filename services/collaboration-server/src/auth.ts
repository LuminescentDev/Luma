import { createRemoteJWKSet, jwtVerify } from "jose";
import type { IncomingHttpHeaders } from "node:http";
import type { Config } from "./config.js";

export interface AuthenticatedUser {
  subject: string;
}

export class Authenticator {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly config: Config) {
    this.jwks = createRemoteJWKSet(new URL(config.jwtJwksUrl));
  }

  async authenticate(headers: IncomingHttpHeaders): Promise<AuthenticatedUser> {
    const authorization = headers.authorization;
    if (!authorization?.startsWith("Bearer ")) throw new HttpError(401, "missing bearer token");
    const token = authorization.slice("Bearer ".length).trim();
    if (!token) throw new HttpError(401, "missing bearer token");
    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: this.config.jwtIssuer,
        audience: this.config.jwtAudience,
        algorithms: ["RS256", "ES256", "EdDSA"],
      });
      if (!payload.sub) throw new HttpError(401, "token has no subject");
      return { subject: payload.sub };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(401, "invalid bearer token");
    }
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
