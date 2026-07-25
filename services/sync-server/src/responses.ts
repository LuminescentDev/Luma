export function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...securityHeaders(),
    },
  });
}

export function securityHeaders(): Record<string, string> {
  return {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
}
