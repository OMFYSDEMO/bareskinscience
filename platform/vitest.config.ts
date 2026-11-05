import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import path from "node:path";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc", environment: "dev" },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations, APP_ENV: "test" } },
      }),
    ],
    test: { include: ["test/**/*.test.ts"], setupFiles: ["./test/apply-migrations.ts"] },
  };
});
