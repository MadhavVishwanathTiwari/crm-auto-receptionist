// Vitest setup. Target selection lives in target.ts — this only loads .env so
// both unit and integration suites see the same environment.

import { config } from "dotenv";

config({ path: ".env", quiet: true });
