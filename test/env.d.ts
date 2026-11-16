import type { Env as WorkerEnv } from "../src/http";

declare global {
  namespace Cloudflare {
    // The test pool's `env` carries the same bindings as the Worker's.
    interface Env extends WorkerEnv {}
  }
}
