import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,

  // The service-role key bypasses RLS entirely. Nothing that can end up in a
  // browser bundle may import the admin client. `scripts/check-no-service-key-
  // in-bundle.mjs` is the belt to this suspenders — this rule catches it at
  // author time, that script catches it at build time.
  {
    files: ["components/**/*.{ts,tsx}", "app/**/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/lib/supabase/admin",
              message:
                "The admin client uses the service role and bypasses RLS. Server-only: use it in app/api/** route handlers, never in a component.",
            },
          ],
        },
      ],
    },
  },

  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "supabase/.temp/**",
    "types/db.ts",
  ]),
]);

export default eslintConfig;
