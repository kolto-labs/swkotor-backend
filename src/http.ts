/** Bindings and vars this Worker reads. All deployment-specific values come from here. */
export interface Env {
  /** Host name the launcher is served from, returned by `GET /config`. */
  SITE_DOMAIN?: string;
  /** Comma-separated origins allowed to call this API from a browser. */
  ALLOWED_ORIGINS?: string;
  /** YouTube channel whose public feed backs `GET /community/videos/latest`. */
  YOUTUBE_CHANNEL_ID?: string;
  /** Published runtime releases: `<version>/runtime-manifest.json` and `<version>/<name>`. */
  RUNTIME_BUCKET: R2Bucket;
}

/** HTTP status codes this API answers with. */
export const Status = {
  OK: 200,
  NoContent: 204,
  PartialContent: 206,
  NotModified: 304,
  BadRequest: 400,
  Forbidden: 403,
  NotFound: 404,
  MethodNotAllowed: 405,
  RangeNotSatisfiable: 416,
  BadGateway: 502,
} as const;

/** The OpenAPI `Error` schema. */
export interface ApiError {
  error: string;
}

export function json(body: unknown, status: number = Status.OK, headers: HeadersInit = {}): Response {
  const h = new Headers(headers);
  h.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers: h });
}

export function error(status: number, message: string): Response {
  const body: ApiError = { error: message };
  return json(body, status, { "Cache-Control": "no-store" });
}

/** Weak comparison, as `If-None-Match` requires. */
export function etagMatches(header: string | null, etag: string): boolean {
  if (header === null) return false;
  // Drops a weak-tag prefix: matches the "W/" in 'W/"abc"'; leaves '"abc"' unchanged.
  // https://regex101.com/?regex=%5EW%5C%2F&testString=W%2F%22abc%22
  const strip = (t: string) => t.trim().replace(/^W\//, "");
  const want = strip(etag);
  return header.split(",").some((t) => t.trim() === "*" || strip(t) === want);
}
