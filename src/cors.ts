import { Status, type Env } from "./http";

const ALLOW_METHODS = "GET, HEAD, OPTIONS";
const ALLOW_HEADERS = "Range, If-None-Match, If-Range";
const EXPOSE_HEADERS = "ETag, Content-Length, Content-Range, Accept-Ranges";

function allowedOrigin(request: Request, env: Env): string | null {
  const origin = request.headers.get("Origin");
  if (origin === null) return null;
  const allowed = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o !== "");
  return allowed.includes(origin) ? origin : null;
}

/** Answers a CORS preflight: 204 for a listed origin, 403 otherwise. */
export function preflight(request: Request, env: Env): Response {
  const origin = allowedOrigin(request, env);
  if (origin === null) return new Response(null, { status: Status.Forbidden, headers: { Vary: "Origin" } });
  return new Response(null, {
    status: Status.NoContent,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": ALLOW_METHODS,
      "Access-Control-Allow-Headers": ALLOW_HEADERS,
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    },
  });
}

/** Adds CORS headers to a response when the request's origin is listed in ALLOWED_ORIGINS. */
export function withCors(request: Request, env: Env, response: Response): Response {
  const res = new Response(response.body, response);
  res.headers.append("Vary", "Origin");
  const origin = allowedOrigin(request, env);
  if (origin !== null) {
    res.headers.set("Access-Control-Allow-Origin", origin);
    res.headers.set("Access-Control-Expose-Headers", EXPOSE_HEADERS);
  }
  return res;
}
