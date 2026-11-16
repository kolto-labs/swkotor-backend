import { env } from "cloudflare:workers";
import type { RuntimeManifest } from "@kolto-labs/kotor-runtime-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/http";

const BASE = "https://api.example";
const ALLOWED = "https://launcher.example";
const DENIED = "https://evil.example";
const VERSION = "1.0.0";
const FILE = "kotor.wasm";
const MISSING = "missing.bin";
const CONTENT = "0123456789abcdefghij";
const SIZE = CONTENT.length;
const DEFAULT_LIMIT = 10;
const FEED_ENTRIES = 12;

async function call(path: string, init: RequestInit = {}, bindings: Env = env): Promise<Response> {
  const request = new Request(BASE + path, init) as Request<unknown, IncomingRequestCfProperties>;
  return worker.fetch(request, bindings);
}

function manifest(version: string, names: string[]): string {
  const body: RuntimeManifest = {
    version,
    protocol: 1,
    qualified: true,
    files: names.map((name) => ({ name, sha256: "0".repeat(64), size: SIZE })),
  };
  return JSON.stringify(body);
}

/** A YouTube channel Atom feed with `n` entries, oldest first, so sorting is exercised. */
function feed(n: number): string {
  const entries = Array.from({ length: n }, (_, i) => {
    const day = String(i + 1).padStart(2, "0");
    return `
  <entry>
    <id>yt:video:vid${i}</id>
    <title>Episode ${i} &amp; more</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=vid${i}"/>
    <published>2026-10-${day}T12:00:00+00:00</published>
    <media:group>
      <media:title>Episode ${i}</media:title>
      <media:thumbnail url="https://i.ytimg.com/vi/vid${i}/hqdefault.jpg" width="480" height="360"/>
    </media:group>
  </entry>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
  <link rel="self" href="https://www.youtube.com/feeds/videos.xml?channel_id=UCexamplechannel"/>
  <title>Example channel</title>${entries}
</feed>`;
}

async function fileEtag(): Promise<string> {
  const head = await env.RUNTIME_BUCKET.head(`${VERSION}/${FILE}`);
  return head!.httpEtag;
}

beforeEach(async () => {
  await env.RUNTIME_BUCKET.put(`${VERSION}/runtime-manifest.json`, manifest(VERSION, [FILE, MISSING]));
  await env.RUNTIME_BUCKET.put(`${VERSION}/${FILE}`, CONTENT);
  // Present in the bucket but not listed by the manifest.
  await env.RUNTIME_BUCKET.put(`${VERSION}/unlisted.bin`, CONTENT);
  // A non-release prefix laid out like a release: only version validation keeps it unreachable.
  await env.RUNTIME_BUCKET.put("uploads/runtime-manifest.json", manifest("uploads", ["x"]));
  await env.RUNTIME_BUCKET.put("uploads/x", CONTENT);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /config", () => {
  it("returns the site domain", async () => {
    const res = await call("/config");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/^application\/json/);
    expect(await res.json()).toEqual({ siteDomain: "launcher.example" });
  });

  it("answers 404 when no site domain is configured", async () => {
    const res = await call("/config", {}, { ...env, SITE_DOMAIN: "" });
    expect(res.status).toBe(404);
    expect(await res.json()).toHaveProperty("error");
  });
});

describe("GET /community/videos/latest", () => {
  function mockFeed(response: () => Response = () => new Response(feed(FEED_ENTRIES))) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async () => response());
  }

  it("returns the default number of videos, newest first", async () => {
    const spy = mockFeed();
    const res = await call("/community/videos/latest");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { videos: { title: string; publishedAt: string }[] };
    expect(body.videos).toHaveLength(DEFAULT_LIMIT);
    expect(body.videos[0]).toEqual({
      title: `Episode ${FEED_ENTRIES - 1} & more`,
      url: `https://www.youtube.com/watch?v=vid${FEED_ENTRIES - 1}`,
      publishedAt: `2026-10-${FEED_ENTRIES}T12:00:00.000Z`,
      thumbnailUrl: `https://i.ytimg.com/vi/vid${FEED_ENTRIES - 1}/hqdefault.jpg`,
    });
    expect(String(spy.mock.calls[0]?.[0])).toContain("channel_id=UCexamplechannel");
  });

  it("honours an explicit limit", async () => {
    mockFeed();
    const res = await call("/community/videos/latest?limit=3");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { videos: unknown[] }).videos).toHaveLength(3);
  });

  it.each(["0", "51", "abc"])("rejects limit=%s with 400", async (limit) => {
    const spy = mockFeed();
    const res = await call(`/community/videos/latest?limit=${limit}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toHaveProperty("error");
    expect(spy).not.toHaveBeenCalled();
  });

  it("answers 404 when YOUTUBE_CHANNEL_ID is missing", async () => {
    const spy = mockFeed();
    const res = await call("/community/videos/latest", {}, { ...env, YOUTUBE_CHANNEL_ID: "" });
    expect(res.status).toBe(404);
    expect(spy).not.toHaveBeenCalled();
  });

  it("answers 502 when the upstream feed fails", async () => {
    mockFeed(() => new Response("unavailable", { status: 503 }));
    const res = await call("/community/videos/latest");
    expect(res.status).toBe(502);
    expect(await res.json()).toHaveProperty("error");
  });
});

describe("GET /runtime/{version}/manifest", () => {
  it("returns the release manifest with an ETag", async () => {
    const res = await call(`/runtime/${VERSION}/manifest`);
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBeTruthy();
    expect(res.headers.get("Cache-Control")).toContain("immutable");
    expect(((await res.json()) as RuntimeManifest).version).toBe(VERSION);
  });

  it("answers 304 to a matching If-None-Match", async () => {
    const etag = (await call(`/runtime/${VERSION}/manifest`)).headers.get("ETag")!;
    const res = await call(`/runtime/${VERSION}/manifest`, { headers: { "If-None-Match": etag } });
    expect(res.status).toBe(304);
  });

  it("answers 404 for an unknown version", async () => {
    const res = await call("/runtime/9.9.9/manifest");
    expect(res.status).toBe(404);
  });
});

describe("GET /runtime/{version}/files/{name}", () => {
  const path = `/runtime/${VERSION}/files/${FILE}`;

  it("returns the whole file", async () => {
    const res = await call(path);
    expect(res.status).toBe(200);
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(res.headers.get("Content-Length")).toBe(String(SIZE));
    expect(await res.text()).toBe(CONTENT);
  });

  it.each([
    ["bytes=0-3", "0123", `bytes 0-3/${SIZE}`],
    ["bytes=-4", "ghij", `bytes 16-19/${SIZE}`],
    ["bytes=10-", "abcdefghij", `bytes 10-19/${SIZE}`],
  ])("answers %s with 206", async (range, body, contentRange) => {
    const res = await call(path, { headers: { Range: range } });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe(contentRange);
    expect(await res.text()).toBe(body);
  });

  it("answers 416 to a range beyond the end", async () => {
    const res = await call(path, { headers: { Range: `bytes=${SIZE}-` } });
    expect(res.status).toBe(416);
    expect(res.headers.get("Content-Range")).toBe(`bytes */${SIZE}`);
  });

  it("ignores Range when If-Range does not match", async () => {
    const res = await call(path, { headers: { Range: "bytes=0-3", "If-Range": '"stale"' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(CONTENT);
  });

  it("honours Range when If-Range matches", async () => {
    const res = await call(path, { headers: { Range: "bytes=0-3", "If-Range": await fileEtag() } });
    expect(res.status).toBe(206);
    expect(await res.text()).toBe("0123");
  });

  it("answers 304 to a matching If-None-Match", async () => {
    const res = await call(path, { headers: { "If-None-Match": await fileEtag() } });
    expect(res.status).toBe(304);
  });

  it("answers 404 when a listed file is missing from the bucket", async () => {
    const res = await call(`/runtime/${VERSION}/files/${MISSING}`);
    expect(res.status).toBe(404);
  });

  it("answers 404 for a file the manifest does not list", async () => {
    const res = await call(`/runtime/${VERSION}/files/unlisted.bin`);
    expect(res.status).toBe(404);
  });
});

describe("path validation", () => {
  it("serves nothing outside a release prefix", async () => {
    expect((await call("/runtime/uploads/manifest")).status).toBe(404);
    expect((await call("/runtime/uploads/files/x")).status).toBe(404);
  });

  it.each([
    `/runtime/${VERSION}/files/..%2Fx`,
    `/runtime/${VERSION}/files/%2e%2e`,
    `/runtime/${VERSION}/files/.hidden`,
    "/runtime/%2e%2e/manifest",
    "/runtime/..%2Fuploads/manifest",
  ])("answers 404 to %s", async (p) => {
    expect((await call(p)).status).toBe(404);
  });
});

describe("CORS", () => {
  it("echoes an allowed origin", async () => {
    const res = await call("/config", { headers: { Origin: ALLOWED } });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED);
    expect(res.headers.get("Access-Control-Expose-Headers")).toContain("Content-Range");
    expect(res.headers.get("Vary")).toContain("Origin");
  });

  it("sends no CORS headers to a denied origin", async () => {
    const res = await call("/config", { headers: { Origin: DENIED } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("answers a preflight from an allowed origin with 204", async () => {
    const res = await call(path(), {
      method: "OPTIONS",
      headers: { Origin: ALLOWED, "Access-Control-Request-Method": "GET" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED);
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Range");
  });

  it("answers a preflight from a denied origin with 403", async () => {
    const res = await call(path(), {
      method: "OPTIONS",
      headers: { Origin: DENIED, "Access-Control-Request-Method": "GET" },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  function path(): string {
    return `/runtime/${VERSION}/files/${FILE}`;
  }
});

describe("routing", () => {
  it("answers 405 with Allow to a non-GET method", async () => {
    const res = await call("/config", { method: "POST", body: "{}" });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
  });

  it("answers 404 to an unknown path", async () => {
    expect((await call("/nope")).status).toBe(404);
  });
});
