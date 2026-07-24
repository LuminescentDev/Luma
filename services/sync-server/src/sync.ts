import { positiveInteger, updateUsage } from "./accounts";
import { HttpError } from "./auth";
import { securityHeaders } from "./responses";
import type { Account, Env } from "./types";

const CONTENT_TYPE = "application/vnd.luma.sync";

function currentKey(account: Account): string {
  return `accounts/${account.storage_id}/current.luma`;
}

function revisionsPrefix(account: Account): string {
  return `accounts/${account.storage_id}/revisions/`;
}

export async function download(env: Env, account: Account): Promise<Response> {
  const object = await env.SYNC_BUCKET.get(currentKey(account));
  if (!object) {
    return new Response(null, { status: 404, headers: securityHeaders() });
  }

  return new Response(object.body, {
    status: 200,
    headers: {
      ...securityHeaders(),
      "content-type": CONTENT_TYPE,
      "content-length": object.size.toString(),
      etag: object.httpEtag,
    },
  });
}

export async function upload(
  request: Request,
  env: Env,
  account: Account,
  context: ExecutionContext,
): Promise<Response> {
  if (request.headers.get("content-type")?.split(";", 1)[0] !== CONTENT_TYPE) {
    throw new HttpError(415, `content type must be ${CONTENT_TYPE}`);
  }
  if (!request.body) {
    throw new HttpError(400, "request body is required");
  }

  const length = parseContentLength(request);
  const maxBlobBytes = positiveInteger(env.MAX_BLOB_BYTES, "MAX_BLOB_BYTES");
  if (length > maxBlobBytes) {
    throw new HttpError(413, "sync blob exceeds the service size limit");
  }
  if (length > account.quota_bytes) {
    throw new HttpError(413, "sync blob exceeds the account quota");
  }

  const key = currentKey(account);
  const current = await env.SYNC_BUCKET.get(key);
  const condition = uploadCondition(request, current);

  if (current) {
    const revisionKey = `${revisionsPrefix(account)}${current.etag}.luma`;
    await env.SYNC_BUCKET.put(revisionKey, current.body, {
      onlyIf: { etagDoesNotMatch: "*" },
      customMetadata: { sourceEtag: current.etag },
    });
  }

  const stored = await env.SYNC_BUCKET.put(key, request.body, {
    onlyIf: condition,
    httpMetadata: { contentType: CONTENT_TYPE },
  });
  if (!stored) {
    throw new HttpError(412, "sync data changed since it was downloaded");
  }

  await updateUsage(env, account.subject, length);
  context.waitUntil(pruneRevisions(env, account));

  return new Response(null, {
    status: 204,
    headers: {
      ...securityHeaders(),
      etag: stored.httpEtag,
    },
  });
}

function uploadCondition(request: Request, current: R2ObjectBody | null): R2Conditional {
  const ifMatch = request.headers.get("if-match");
  const ifNoneMatch = request.headers.get("if-none-match");
  if (current) {
    if (!ifMatch || ifNoneMatch) {
      throw new HttpError(428, "If-Match is required for an existing sync blob");
    }
    return { etagMatches: normalizeEtag(ifMatch) };
  }
  if (ifNoneMatch !== "*" || ifMatch) {
    throw new HttpError(428, "If-None-Match: * is required for the first sync blob");
  }
  return { etagDoesNotMatch: "*" };
}

function normalizeEtag(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("W/")) {
    throw new HttpError(400, "weak ETags are not supported");
  }
  return trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed;
}

function parseContentLength(request: Request): number {
  const value = request.headers.get("content-length");
  if (!value || !/^\d+$/.test(value)) {
    throw new HttpError(411, "Content-Length is required");
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length <= 0) {
    throw new HttpError(400, "Content-Length is invalid");
  }
  return length;
}

async function pruneRevisions(env: Env, account: Account): Promise<void> {
  const limit = positiveInteger(env.REVISION_LIMIT, "REVISION_LIMIT");
  const listed = await env.SYNC_BUCKET.list({
    prefix: revisionsPrefix(account),
    limit: Math.min(limit + 100, 1_000),
  });
  if (listed.objects.length <= limit) return;

  const expired = listed.objects
    .sort((left, right) => right.uploaded.getTime() - left.uploaded.getTime())
    .slice(limit)
    .map((object) => object.key);
  if (expired.length > 0) {
    await env.SYNC_BUCKET.delete(expired);
  }
}

export async function deleteAll(env: Env, account: Account): Promise<void> {
  const keys = [currentKey(account)];
  let cursor: string | undefined;
  do {
    const listed = await env.SYNC_BUCKET.list({
      prefix: revisionsPrefix(account),
      cursor,
      limit: 1_000,
    });
    keys.push(...listed.objects.map((object) => object.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  if (keys.length > 0) {
    await env.SYNC_BUCKET.delete(keys);
  }
}
