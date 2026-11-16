import type { LauncherConfig } from "@kolto-labs/kotor-runtime-api";
import { preflight, withCors } from "./cors";
import { error, json, Status, type Env } from "./http";
import { getFile, getManifest } from "./runtime";
import { latestVideos } from "./videos";

export type { Env } from "./http";

function getConfig(env: Env): Response {
  const siteDomain = env.SITE_DOMAIN?.trim();
  if (!siteDomain) return error(Status.NotFound, "no launcher config");
  const body: LauncherConfig = { siteDomain };
  return json(body, Status.OK, { "Cache-Control": "public, max-age=300" });
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  let segments: string[];
  try {
    segments = url.pathname.split("/").slice(1).map(decodeURIComponent);
  } catch {
    return error(Status.NotFound, "not found");
  }
  const [, version, , name] = segments;
  // NUL cannot appear in a URL path, so joining on it keeps segment boundaries exact.
  const path = segments.join("\0");

  if (path === "config") return getConfig(env);
  if (path === "community\0videos\0latest") return latestVideos(url, env);
  if (path === `runtime\0${version}\0manifest`) return getManifest(request, env, version!);
  if (path === `runtime\0${version}\0files\0${name}`) {
    return getFile(request, env, version!, name!);
  }
  return error(Status.NotFound, "not found");
}

export default {
  async fetch(request, env): Promise<Response> {
    if (request.method === "OPTIONS") return preflight(request, env);
    if (request.method !== "GET" && request.method !== "HEAD") {
      const res = error(Status.MethodNotAllowed, "method not allowed");
      res.headers.set("Allow", "GET, HEAD, OPTIONS");
      return withCors(request, env, res);
    }
    return withCors(request, env, await route(request, env));
  },
} satisfies ExportedHandler<Env>;
