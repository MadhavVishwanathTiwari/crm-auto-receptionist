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

  // Every time on screen goes through lib/time/format.ts. The runtime's own
  // zone and locale are UTC/en-US on the server and the operator's in the
  // browser, so a bare toLocaleString() renders one string on each side:
  // times flashed in UTC and six screens threw hydration error #418 (Sep 2026).
  {
    files: ["app/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.property.name=/^toLocale(Date|Time)?String$/][arguments.length=0]",
          message:
            "Use formatYours() or formatCount() from lib/time/format.ts. The runtime's zone and locale differ between server and browser.",
        },
        {
          selector:
            "CallExpression[callee.property.name=/^toLocale(Date|Time)?String$/][arguments.0.name='undefined']",
          message:
            "Use formatYours() from lib/time/format.ts. An undefined locale is the runtime's, which differs between server and browser.",
        },
        {
          selector: "CallExpression[callee.property.name='toRelative'][arguments.length=0]",
          message:
            "Use relativeTo(iso, renderedAt) from lib/time/format.ts, so server and browser measure from the same moment.",
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
