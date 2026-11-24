/**
 * Move active board-owned routine recovery actions to the recovery
 * coordinator agent, close open actions on done/cancelled source issues and
 * re-route coordinator-routed actions whose owner cannot read the source
 * issue. Dry-run is the default; pass `--apply` to write.
 *
 *   node dist/services/recovery/recovery-owner-backfill-cli.js [--company <id>] [--apply]
 *
 * Reads the database URL from DATABASE_URL or the Paperclip config.
 */
import { createDb } from "@paperclipai/db";
import { loadConfig } from "../../config.js";
import { backfillRecoveryCoordinatorOwners } from "./recovery-owner-backfill.js";

function parseFlag(argv: string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index < 0) return null;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

async function main(argv: string[]) {
  const config = loadConfig();
  const dbUrl =
    process.env.DATABASE_URL?.trim()
    || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;
  const db = createDb(dbUrl);
  const result = await backfillRecoveryCoordinatorOwners(db, {
    companyId: parseFlag(argv, "--company"),
    dryRun: !argv.includes("--apply"),
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

void main(process.argv.slice(2)).catch((error) => {
  console.error(`Recovery coordinator backfill failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
