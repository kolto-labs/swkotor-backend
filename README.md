# swkotor-backend

The optional server side, as a Cloudflare Worker. The launcher works without it. This is a
reference implementation of the backend API in
[`kotor-runtime-api`](https://github.com/kolto-labs/kotor-runtime-api) (`openapi/backend.yaml`);
anything that implements that OpenAPI document can replace it.

## Endpoints

- `GET /config`: launcher configuration (`{ "siteDomain": ... }`).
- `GET /community/videos/latest?limit=1..50`: latest videos from a YouTube channel's public feed,
  cached for ten minutes.
- `GET /runtime/{version}/manifest` and `GET /runtime/{version}/files/{name}`: published runtime
  release files from R2, with ETag, `If-None-Match` and single byte ranges (206 and 416).

Only files the release manifest lists are served. Versions must be semver and names a single path
segment, so nothing else in the bucket can be reached.

## Configure

Set these in `wrangler.jsonc`, a wrangler environment, or the dashboard:

| Name | What |
| --- | --- |
| `SITE_DOMAIN` | Host name the launcher is served from, e.g. `launcher.example`. Empty: `/config` answers 404. |
| `ALLOWED_ORIGINS` | Comma-separated origins allowed to call the API from a browser. |
| `YOUTUBE_CHANNEL_ID` | Channel for the video feed. Empty: the endpoint answers 404. |
| `RUNTIME_BUCKET` | R2 binding holding published runtime releases. |

Bucket layout, one prefix per release:

```text
<version>/runtime-manifest.json
<version>/<name>          # every file the manifest lists
```

## Develop

```sh
npm install        # npm 11; npm 10 fails on this dependency set
npx tsc --noEmit
npx vitest run     # runs in the Workers runtime; no network
npx wrangler dev
npx wrangler deploy
```

## Not here

Launcher pages, the runtime build, anything that needs the user's game files. Game files are never
uploaded to or served from a backend.

## Where this fits

One of the repos that together run KotOR I and II in the browser. The full map, the contracts and
the roadmap are in [ARCHITECTURE.md](https://github.com/kolto-labs/swkotor-web/blob/master/ARCHITECTURE.md).

No game files are distributed. Bring your own copy of KotOR I or II.
Not affiliated with Lucasfilm, Disney, BioWare, Obsidian or Aspyr.

MIT licence.
