import "dotenv/config";
import { defineConfig } from "prisma/config";

// Only `migrate` and friends need a connection. `prisma generate` (run by
// postinstall) reads the schema alone, so a missing DIRECT_URL must not fail
// `npm install` on a fresh machine; commands that do connect report it
// themselves.
const databaseUrl = process.env["DIRECT_URL"]

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    ...(databaseUrl ? { url: databaseUrl } : {}),
  },
});
