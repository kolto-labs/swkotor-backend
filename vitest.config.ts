import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          SITE_DOMAIN: "launcher.example",
          ALLOWED_ORIGINS: "https://launcher.example, http://localhost:5173",
          YOUTUBE_CHANNEL_ID: "UCexamplechannel",
        },
      },
    }),
  ],
});
