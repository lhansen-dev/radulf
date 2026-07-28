import path from "node:path";
import { defineConfig } from "drizzle-kit";

// Mirror the app's data-dir resolution (src/db/index.ts) so drizzle-kit tooling
// (db-studio / db-migrate) targets the SAME sqlite file the running app uses.
// The Makefile sources .env.local before invoking these targets so this env var
// matches what `next dev` sees; unset, both sides default to ./data.
const dataDir = process.env.RADULF_DATA_DIR ?? "./data";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: path.join(dataDir, "radulf.db") },
});
