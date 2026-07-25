export interface Config {
  host: string;
  port: number;
  instanceId: string;
  databaseUrl: string;
  redisUrl: string;
  jwtIssuer: string;
  jwtAudience: string;
  jwtJwksUrl: string;
  oidcClientId: string;
  oidcDeviceAuthorizationEndpoint: string;
  oidcTokenEndpoint: string;
  r2Endpoint: string;
  r2Region: string;
  r2Bucket: string;
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
  roomHistoryLimit: number;
  maxEventBytes: number;
  maxSnapshotBytes: number;
  ticketTtlSeconds: number;
  presenceTtlSeconds: number;
  controlLeaseTtlSeconds: number;
  httpRequestsPerMinute: number;
  websocketMessagesPerSecond: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    host: env.HOST ?? "0.0.0.0",
    port: positiveInteger(env.PORT ?? "8788", "PORT"),
    instanceId: env.INSTANCE_ID ?? crypto.randomUUID(),
    databaseUrl: required(env, "DATABASE_URL"),
    redisUrl: required(env, "REDIS_URL"),
    jwtIssuer: required(env, "JWT_ISSUER"),
    jwtAudience: required(env, "JWT_AUDIENCE"),
    jwtJwksUrl: required(env, "JWT_JWKS_URL"),
    oidcClientId: required(env, "OIDC_CLIENT_ID"),
    oidcDeviceAuthorizationEndpoint: required(env, "OIDC_DEVICE_AUTHORIZATION_ENDPOINT"),
    oidcTokenEndpoint: required(env, "OIDC_TOKEN_ENDPOINT"),
    r2Endpoint: required(env, "R2_ENDPOINT"),
    r2Region: env.R2_REGION ?? "auto",
    r2Bucket: required(env, "R2_BUCKET"),
    r2AccessKeyId: required(env, "R2_ACCESS_KEY_ID"),
    r2SecretAccessKey: required(env, "R2_SECRET_ACCESS_KEY"),
    roomHistoryLimit: positiveInteger(env.ROOM_HISTORY_LIMIT ?? "10000", "ROOM_HISTORY_LIMIT"),
    maxEventBytes: positiveInteger(env.MAX_EVENT_BYTES ?? "262144", "MAX_EVENT_BYTES"),
    maxSnapshotBytes: positiveInteger(
      env.MAX_SNAPSHOT_BYTES ?? "67108864",
      "MAX_SNAPSHOT_BYTES",
    ),
    ticketTtlSeconds: positiveInteger(env.TICKET_TTL_SECONDS ?? "30", "TICKET_TTL_SECONDS"),
    presenceTtlSeconds: positiveInteger(env.PRESENCE_TTL_SECONDS ?? "45", "PRESENCE_TTL_SECONDS"),
    controlLeaseTtlSeconds: positiveInteger(
      env.CONTROL_LEASE_TTL_SECONDS ?? "15",
      "CONTROL_LEASE_TTL_SECONDS",
    ),
    httpRequestsPerMinute: positiveInteger(
      env.HTTP_REQUESTS_PER_MINUTE ?? "600",
      "HTTP_REQUESTS_PER_MINUTE",
    ),
    websocketMessagesPerSecond: positiveInteger(
      env.WEBSOCKET_MESSAGES_PER_SECOND ?? "100",
      "WEBSOCKET_MESSAGES_PER_SECOND",
    ),
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}
