# swkotor-backend

Status: scaffold. No code yet.

The optional server side. The launcher works without it; this repo is a reference implementation on
Cloudflare Workers, and anything that implements the same API can stand in for it.

## Responsibility

- `GET /config`: launcher configuration.
- `GET /community/videos/latest`: community feed.
- `GET /runtime/{version}/manifest` and `/runtime/{version}/files/{name}`: deliver published
  `kotor-wasm` release files, including chunked streaming of large archives.

## Not here

Launcher pages, the runtime build, anything that needs the user's game files. Game files are never
uploaded to or served from a backend.

## Contract

The OpenAPI document in `kotor-runtime-api`. Secrets and the site domain come from deployment
configuration, never from source.

## Where this fits

One of the repos that together run KotOR I and II in the browser. The full map, the contracts and
the roadmap are in [ARCHITECTURE.md](https://github.com/kolto-labs/swkotor-web/blob/master/ARCHITECTURE.md).

No game files are distributed. Bring your own copy of KotOR I or II.
Not affiliated with Lucasfilm, Disney, BioWare, Obsidian or Aspyr.
