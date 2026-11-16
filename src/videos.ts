import type { Video, VideoList } from "@kolto-labs/kotor-runtime-api";
import { error, json, Status, type Env } from "./http";

const FEED_URL = "https://www.youtube.com/feeds/videos.xml?channel_id=";
/** Seconds the upstream feed and our response may be cached. */
export const FEED_TTL = 600;
const DEFAULT_LIMIT = 10;
const MIN_LIMIT = 1;
const MAX_LIMIT = 50;
const HEX = 16;
const DECIMAL = 10;

const NAMED_ENTITIES: Record<string, string> = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };

// An XML entity: matches "&amp;", "&#39;", "&#x27;"; rejects "&nbsp" (no ";") and "& x;".
// https://regex101.com/?regex=%26(%23x%5B0-9a-fA-F%5D%2B%7C%23%5B0-9%5D%2B%7C%5Ba-z%5D%2B)%3B&testString=%26amp%3B
const ENTITY_RE = /&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g;
// A whole CDATA section: matches "<![CDATA[a & b]]>"; rejects "plain text".
// https://regex101.com/?regex=%5E%3C!%5C%5BCDATA%5C%5B(%5B%5Cs%5CS%5D*)%5C%5D%5C%5D%3E%24&testString=%3C!%5BCDATA%5Ba%5D%5D%3E
const CDATA_RE = /^<!\[CDATA\[([\s\S]*)\]\]>$/;
// One Atom entry: matches "<entry><title>x</title></entry>"; rejects "<entryx>" and "<entries>".
// https://regex101.com/?regex=%3Centry(%3F%3A%5Cs%5B%5E%3E%5D*)%3F%3E(%5B%5Cs%5CS%5D*%3F)%3C%5C%2Fentry%3E&testString=%3Centry%3Ex%3C%2Fentry%3E
const ENTRY_RE = /<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/g;
// The watch-page link: matches '<link rel="alternate" href="https://..."/>'; rejects '<link rel="self" .../>'.
// https://regex101.com/?regex=%3Clink%5Cs%5B%5E%3E%5D*rel%3D%22alternate%22%5B%5E%3E%5D*%3E&testString=%3Clink%20rel%3D%22alternate%22%20href%3D%22x%22%2F%3E
const ALTERNATE_LINK_RE = /<link\s[^>]*rel="alternate"[^>]*>/;
// The thumbnail element: matches '<media:thumbnail url="https://..."/>'; rejects '<media:title>'.
// https://regex101.com/?regex=%3Cmedia%3Athumbnail%5Cs%5B%5E%3E%5D*%3E&testString=%3Cmedia%3Athumbnail%20url%3D%22x%22%2F%3E
const THUMBNAIL_RE = /<media:thumbnail\s[^>]*>/;
// The limit query value: matches "1", "50", "999"; rejects "", "-1", "2.5", "1e1".
// https://regex101.com/?regex=%5E%5B0-9%5D%7B1%2C3%7D%24&testString=50
const LIMIT_RE = /^[0-9]{1,3}$/;

function decodeXml(s: string): string {
  return s.replace(CDATA_RE, "$1").replace(ENTITY_RE, (whole, e: string) => {
    if (e.startsWith("#x")) return String.fromCodePoint(parseInt(e.slice("#x".length), HEX));
    if (e.startsWith("#")) return String.fromCodePoint(parseInt(e.slice(1), DECIMAL));
    return NAMED_ENTITIES[e] ?? whole;
  });
}

function text(xml: string, tag: string): string | undefined {
  // The tag's text content; `tag` is a fixed element name such as "title", never user input.
  // Matches "<title>x</title>"; rejects "<titles>x</titles>".
  // https://regex101.com/?regex=%3Ctitle(%3F%3A%5Cs%5B%5E%3E%5D*)%3F%3E(%5B%5Cs%5CS%5D*%3F)%3C%2Ftitle%3E&testString=%3Ctitle%3Ex%3C%2Ftitle%3E
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
  return m?.[1] === undefined ? undefined : decodeXml(m[1].trim());
}

function attr(element: string | undefined, name: string): string | undefined {
  // A double-quoted attribute; `name` is a fixed attribute name. Matches ' href="x"'; rejects ' xhref="x"'.
  // https://regex101.com/?regex=%5Cshref%3D%22(%5B%5E%22%5D*)%22&testString=%3Clink%20href%3D%22x%22%3E
  const m = element?.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m?.[1] === undefined ? undefined : decodeXml(m[1]);
}

function httpsUrl(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  try {
    return new URL(s).protocol === "https:" ? s : undefined;
  } catch {
    return undefined;
  }
}

function parseEntry(entry: string): Video | null {
  const title = text(entry, "title");
  const url = httpsUrl(attr(entry.match(ALTERNATE_LINK_RE)?.[0], "href"));
  const published = new Date(text(entry, "published") ?? "");
  if (!title || !url || Number.isNaN(published.getTime())) return null;
  const thumbnailUrl = httpsUrl(attr(entry.match(THUMBNAIL_RE)?.[0], "url"));
  return { title, url, publishedAt: published.toISOString(), ...(thumbnailUrl ? { thumbnailUrl } : {}) };
}

/** Parses a YouTube channel Atom feed into videos, newest first. Malformed entries are skipped. */
export function parseFeed(xml: string): Video[] {
  return [...xml.matchAll(ENTRY_RE)]
    .map((m) => parseEntry(m[1] ?? ""))
    .filter((v): v is Video => v !== null)
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

export async function latestVideos(url: URL, env: Env): Promise<Response> {
  const raw = url.searchParams.get("limit");
  const limit = raw === null ? DEFAULT_LIMIT : Number(raw);
  if (raw !== null && (!LIMIT_RE.test(raw) || limit < MIN_LIMIT || limit > MAX_LIMIT)) {
    return error(Status.BadRequest, "limit must be an integer from 1 to 50");
  }

  const channel = env.YOUTUBE_CHANNEL_ID?.trim();
  if (!channel) return error(Status.NotFound, "no community feed is configured");

  // The edge caches the upstream feed for FEED_TTL, so YouTube sees at most one fetch per window.
  const upstream = await fetch(FEED_URL + encodeURIComponent(channel), {
    cf: { cacheTtl: FEED_TTL, cacheEverything: true },
  });
  if (!upstream.ok) return error(Status.BadGateway, "community feed unavailable");

  const body: VideoList = { videos: parseFeed(await upstream.text()).slice(0, limit) };
  return json(body, Status.OK, { "Cache-Control": `public, max-age=${FEED_TTL}` });
}
