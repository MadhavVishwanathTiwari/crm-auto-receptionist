import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
      // The integration suites import the cron route handlers directly, and
      // those pull in modules guarded by `import "server-only"`. See the stub
      // for why that package throws here and why aliasing beats adding the
      // react-server resolve condition.
      "server-only": fileURLToPath(
        new URL("./tests/setup/server-only-stub.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    globals: false,
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup/env.ts"],
    // RLS tests talk to a real local Postgres and deliberately race each other
    // (two users claiming the same lead). Running files in parallel against one
    // shared database makes those races non-deterministic, so serialise.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
