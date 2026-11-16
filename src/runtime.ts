import type { RuntimeManifest } from "@kolto-labs/kotor-runtime-api";
import { error, etagMatches, Status, type Env } from "./http";

// Patterns from the OpenAPI document. They admit no "/" and no leading ".", so a request can only
// ever name `<semver>/runtime-manifest.json` or `<semver>/<single segment>` in the bucket.
// Semver: matches "1.2.3", "0.4.0-rc.1+build.5"; rejects "01.2.3", "../1.2.3", "1.2".
// https://regex101.com/?regex=%5E(0%7C%5B1-9%5D%5B0-9%5D*)%5C.(0%7C%5B1-9%5D%5B0-9%5D*)%5C.(0%7C%5B1-9%5D%5B0-9%5D*)&testString=1.2.3
const VERSION_RE =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
// One path segment: matches "kotor.wasm", "data_01.bin"; rejects "..", ".hidden", "a/b".
// https://regex101.com/?regex=%5E%5BA-Za-z0-9_%5D%5BA-Za-z0-9._-%5D*%24&testString=kotor.wasm
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const MAX_SEGMENT = 128;

/** A published release never changes. */
const IMMUTABLE = "public, max-age=31536000, immutable";

export function validVersion(v: string): boolean {
  return v.length <= MAX_SEGMENT && VERSION_RE.test(v);
}

export function validName(n: string): boolean {
  return n.length <= MAX_SEGMENT && NAME_RE.test(n);
}

const manifestKey = (version: string) => `${version}/runtime-manifest.json`;

export async function getManifest(request: Request, env: Env, version: string): Promise<Response> {
  if (!validVersion(version)) return error(Status.NotFound, "unknown runtime version");
  const head = await env.RUNTIME_BUCKET.head(manifestKey(version));
  if (head === null) return error(Status.NotFound, "unknown runtime version");

  const headers = new Headers({ ETag: head.httpEtag, "Cache-Control": IMMUTABLE });
  if (etagMatches(request.headers.get("If-None-Match"), head.httpEtag)) {
    return new Response(null, { status: Status.NotModified, headers });
  }
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Content-Length", String(head.size));
  if (request.method === "HEAD") return new Response(null, { headers });

  const obj = await env.RUNTIME_BUCKET.get(manifestKey(version));
  if (obj === null) return error(Status.NotFound, "unknown runtime version");
  return new Response(obj.body, { headers });
}

type ByteRange = { offset: number; length: number };

/**
 * Parses a single `bytes=` range against `size`. Returns null when the header is absent or not a
 * single well-formed range (the whole file is then sent), "unsatisfiable" for a 416.
 */
export function parseRange(header: string | null, size: number): ByteRange | "unsatisfiable" | null {
  // One byte range: matches "bytes=0-99", "bytes=100-", "bytes=-500"; rejects "bytes=0-1,5-9".
  // https://regex101.com/?regex=%5Ebytes%3D(%5B0-9%5D*)-(%5B0-9%5D*)%24&testString=bytes%3D0-99
  const m = header?.match(/^bytes=([0-9]*)-([0-9]*)$/);
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (suffix === 0 || size === 0) return "unsatisfiable";
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const start = Number(m[1]);
  const end = m[2] === "" ? size - 1 : Number(m[2]);
  // Checked before end < start: for "bytes=<size>-" the defaulted end is size - 1, below start.
  if (start >= size) return "unsatisfiable";
  if (end < start) return null;
  return { offset: start, length: Math.min(end, size - 1) - start + 1 };
}

async function isListed(env: Env, version: string, name: string): Promise<boolean> {
  const obj = await env.RUNTIME_BUCKET.get(manifestKey(version));
  if (obj === null) return false;
  const manifest = await obj.json<RuntimeManifest>();
  return Array.isArray(manifest.files) && manifest.files.some((f) => f.name === name);
}

export async function getFile(
  request: Request,
  env: Env,
  version: string,
  name: string,
): Promise<Response> {
  if (!validVersion(version) || !validName(name)) return error(Status.NotFound, "no such runtime file");
  // Only files the release manifest lists are served, never anything else in the bucket.
  if (!(await isListed(env, version, name))) return error(Status.NotFound, "no such runtime file");

  const key = `${version}/${name}`;
  const head = await env.RUNTIME_BUCKET.head(key);
  if (head === null) return error(Status.NotFound, "no such runtime file");

  const size = head.size;
  const headers = new Headers({
    ETag: head.httpEtag,
    "Cache-Control": IMMUTABLE,
    "Accept-Ranges": "bytes",
  });
  if (etagMatches(request.headers.get("If-None-Match"), head.httpEtag)) {
    return new Response(null, { status: Status.NotModified, headers });
  }

  const ifRange = request.headers.get("If-Range");
  const range =
    ifRange === null || ifRange.trim() === head.httpEtag
      ? parseRange(request.headers.get("Range"), size)
      : null;
  if (range === "unsatisfiable") {
    headers.set("Content-Range", `bytes */${size}`);
    return new Response(null, { status: Status.RangeNotSatisfiable, headers });
  }

  headers.set("Content-Type", "application/octet-stream");
  let status: number = Status.OK;
  if (range !== null) {
    status = Status.PartialContent;
    headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${size}`);
    headers.set("Content-Length", String(range.length));
  } else {
    headers.set("Content-Length", String(size));
  }
  if (request.method === "HEAD") return new Response(null, { status, headers });

  const obj = await env.RUNTIME_BUCKET.get(key, range === null ? {} : { range });
  if (obj === null) return error(Status.NotFound, "no such runtime file");
  return new Response(obj.body, { status, headers });
}
