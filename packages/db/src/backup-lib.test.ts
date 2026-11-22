import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  cleanupStalePartialBackups,
  createBufferedTextFileWriter,
  createGzipTextFileWriter,
  runDatabaseBackup,
  runDatabaseRestore,
} from "./backup-lib.js";
import { ensurePostgresDatabase } from "./client.js";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void> | void> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

async function createTempDatabase(): Promise<string> {
  const db = await startEmbeddedPostgresTestDatabase("paperclip-db-backup-");
  cleanups.push(db.cleanup);
  return db.connectionString;
}

async function createSiblingDatabase(connectionString: string, databaseName: string): Promise<string> {
  const adminUrl = new URL(connectionString);
  adminUrl.pathname = "/postgres";
  await ensurePostgresDatabase(adminUrl.toString(), databaseName);
  const targetUrl = new URL(connectionString);
  targetUrl.pathname = `/${databaseName}`;
  return targetUrl.toString();
}

async function waitFor(condition: () => boolean | Promise<boolean>, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
}

function archives(dir: string): string[] {
  return fs.readdirSync(dir).filter((name) => name.endsWith(".sql.gz")).sort();
}

function partials(dir: string): string[] {
  return fs.readdirSync(dir).filter((name) => name.endsWith(".sql.gz.partial")).sort();
}

async function withPgDumpFixture<T>(dir: string, script: string, run: () => Promise<T>): Promise<T> {
  const executable = path.join(dir, "pg-dump-fixture");
  fs.writeFileSync(executable, `#!/bin/sh\n${script}`, { mode: 0o700 });
  const previous = process.env.PAPERCLIP_PG_DUMP_PATH;
  process.env.PAPERCLIP_PG_DUMP_PATH = executable;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.PAPERCLIP_PG_DUMP_PATH;
    else process.env.PAPERCLIP_PG_DUMP_PATH = previous;
  }
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    await cleanup?.();
  }
}, 60_000);

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres backup tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("createBufferedTextFileWriter", () => {
  it("preserves line boundaries across buffered flushes", async () => {
    const tempDir = createTempDir("paperclip-buffered-writer-");
    const outputPath = path.join(tempDir, "backup.sql");
    const writer = createBufferedTextFileWriter(outputPath, 16);
    const lines = [
      "-- header",
      "BEGIN;",
      "",
      "INSERT INTO test VALUES (1);",
      "-- footer",
    ];

    for (const line of lines) {
      writer.emit(line);
    }

    await writer.close();

    expect(fs.readFileSync(outputPath, "utf8")).toBe(lines.join("\n"));
  });
});

describe("createGzipTextFileWriter", () => {
  it("gunzips to exactly what the plain buffered writer writes for the same calls", async () => {
    const tempDir = createTempDir("paperclip-gzip-writer-");
    const plainPath = path.join(tempDir, "plain.sql");
    const gzipPath = path.join(tempDir, "stream.sql.gz");
    const plain = createBufferedTextFileWriter(plainPath, 64);
    const gzip = createGzipTextFileWriter(gzipPath, 64);
    const writers = [plain, gzip];
    const apply = async (step: (writer: typeof plain) => unknown) => {
      for (const writer of writers) await step(writer);
    };

    await apply((w) => w.emit("-- header"));
    await apply((w) => w.emit(""));
    for (let i = 0; i < 500; i++) {
      await apply((w) => w.emit(`INSERT INTO t VALUES (${i}, 'r\u00e9sum\u00e9 ${"x".repeat(i % 37)}');`));
      if (i % 97 === 0) await apply((w) => w.drain());
      if (i % 151 === 0) {
        await apply((w) => w.writeRaw("\n"));
        await apply((w) => w.writeRaw(Buffer.from(`${i}\tcopy row\n`)));
        await apply((w) => w.writeRaw("\\.\n"));
      }
    }
    await apply((w) => w.emit("COMMIT;"));
    await apply((w) => w.emit(""));
    await apply((w) => w.close());

    const expected = fs.readFileSync(plainPath);
    expect(expected.length).toBeGreaterThan(10_000);
    expect(gunzipSync(fs.readFileSync(gzipPath)).equals(expected)).toBe(true);
    expect(expected.toString("utf8").endsWith("COMMIT;\n")).toBe(true);
  });

  it("rethrows the underlying stream error and leaves no file when the output cannot be written", async () => {
    const tempDir = createTempDir("paperclip-gzip-writer-fail-");
    const gzipPath = path.join(tempDir, "missing-dir", "stream.sql.gz");
    const writer = createGzipTextFileWriter(gzipPath, 1);
    writer.emit("SELECT 1;");
    await expect(writer.close()).rejects.toMatchObject({ code: "ENOENT" });
    await writer.abort();
    expect(fs.existsSync(gzipPath)).toBe(false);
  });
});

describe("cleanupStalePartialBackups", () => {
  it("removes only stale partial archives for the prefix", () => {
    const dir = createTempDir("paperclip-partial-cleanup-");
    const stale = path.join(dir, "paperclip-2026-01-01T00-00-00.sql.gz.partial");
    const fresh = path.join(dir, "paperclip-2026-01-02T00-00-00.sql.gz.partial");
    const archive = path.join(dir, "paperclip-2026-01-01T00-00-00.sql.gz");
    const otherPrefix = path.join(dir, "other-2026-01-01T00-00-00.sql.gz.partial");
    for (const file of [stale, fresh, archive, otherPrefix]) fs.writeFileSync(file, "x");
    for (const file of [stale, archive, otherPrefix]) fs.utimesSync(file, new Date(0), new Date(0));
    expect(cleanupStalePartialBackups(dir, 60 * 60 * 1000)).toBe(1);
    expect(fs.readdirSync(dir).sort()).toEqual([
      path.basename(otherPrefix),
      path.basename(archive),
      path.basename(fresh),
    ].sort());
    expect(cleanupStalePartialBackups(path.join(dir, "missing"), 0)).toBe(0);
  });
});

describeEmbeddedPostgres("runDatabaseBackup atomic publish", () => {
  const retention = { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 };

  it("pg_dump: only a .partial exists mid-stream and a completed run leaves exactly one .sql.gz", async () => {
    const connectionString = await createTempDatabase();
    const dir = createTempDir("atomic-pg-dump-");
    const backupDir = path.join(dir, "backups");
    const started = path.join(dir, "started");
    const release = path.join(dir, "release");
    const result = await withPgDumpFixture(
      dir,
      `printf 'SELECT 1;\\n'\ntouch '${started}'\nwhile [ ! -e '${release}' ]; do sleep 0.05; done\nprintf 'SELECT 2;\\n'\n`,
      async () => {
        const pending = runDatabaseBackup({ connectionString, backupDir, retention, backupEngine: "pg_dump" });
        pending.catch(() => {});
        await waitFor(() => fs.existsSync(started), "pg_dump fixture to start");
        await waitFor(() => fs.existsSync(backupDir) && partials(backupDir).length === 1, "partial archive");
        // A kill at this point would leave nothing under an archive name.
        expect(archives(backupDir)).toEqual([]);
        fs.writeFileSync(release, "");
        return pending;
      },
    );
    expect(archives(backupDir)).toEqual([path.basename(result.backupFile)]);
    expect(partials(backupDir)).toEqual([]);
    expect(gunzipSync(fs.readFileSync(result.backupFile)).toString()).toBe("SELECT 1;\nSELECT 2;\n");
    expect(result.sizeBytes).toBe(fs.statSync(result.backupFile).size);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("pg_dump: a dump killed mid-stream leaves no .sql.gz and no .partial", async () => {
    const connectionString = await createTempDatabase();
    const dir = createTempDir("atomic-pg-dump-kill-");
    const backupDir = path.join(dir, "backups");
    await withPgDumpFixture(dir, "printf 'SELECT 1;\\n'\nkill -9 $$\n", async () => {
      await expect(runDatabaseBackup({ connectionString, backupDir, retention, backupEngine: "pg_dump" }))
        .rejects.toThrow();
    });
    expect(archives(backupDir)).toEqual([]);
    expect(partials(backupDir)).toEqual([]);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("pruning ignores .partial files", async () => {
    const connectionString = await createTempDatabase();
    const dir = createTempDir("atomic-prune-");
    const backupDir = path.join(dir, "backups");
    fs.mkdirSync(backupDir);
    const oldArchive = path.join(backupDir, "paperclip-2020-01-01T00-00-00.sql.gz");
    const oldPartial = path.join(backupDir, "paperclip-2020-01-02T00-00-00.sql.gz.partial");
    for (const file of [oldArchive, oldPartial]) {
      fs.writeFileSync(file, gzipSync("SELECT 'old';"));
      fs.utimesSync(file, new Date(0), new Date(0));
    }
    const result = await withPgDumpFixture(dir, "printf 'SELECT 1;\\n'\n", () =>
      runDatabaseBackup({ connectionString, backupDir, retention, backupEngine: "pg_dump", stalePartialMaxAgeMs: Infinity }));
    expect(result.prunedCount).toBe(1);
    expect(fs.existsSync(oldArchive)).toBe(false);
    expect(fs.existsSync(oldPartial)).toBe(true);
    expect(archives(backupDir)).toEqual([path.basename(result.backupFile)]);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("each run removes stale .partial files but keeps fresh ones", async () => {
    const connectionString = await createTempDatabase();
    const dir = createTempDir("atomic-stale-");
    const backupDir = path.join(dir, "backups");
    fs.mkdirSync(backupDir);
    const stale = path.join(backupDir, "paperclip-2020-01-02T00-00-00.sql.gz.partial");
    const fresh = path.join(backupDir, "paperclip-concurrent.sql.gz.partial");
    fs.writeFileSync(stale, "x");
    fs.writeFileSync(fresh, "x");
    fs.utimesSync(stale, new Date(Date.now() - 25 * 60 * 60 * 1000), new Date(Date.now() - 25 * 60 * 60 * 1000));
    const result = await withPgDumpFixture(dir, "printf 'SELECT 1;\\n'\n", () =>
      runDatabaseBackup({ connectionString, backupDir, retention, backupEngine: "pg_dump" }));
    expect(fs.existsSync(stale)).toBe(false);
    expect(partials(backupDir)).toEqual([path.basename(fresh)]);
    expect(archives(backupDir)).toEqual([path.basename(result.backupFile)]);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("javascript: an abort mid-stream leaves no .sql.gz and a completed run leaves exactly one", async () => {
    const connectionString = await createTempDatabase();
    const backupDir = createTempDir("atomic-javascript-");
    const sql = postgres(connectionString, { max: 2, onnotice: () => {} });
    try {
      await sql.unsafe(`
        CREATE TABLE atomic_fixture (id integer PRIMARY KEY, value text NOT NULL);
        INSERT INTO atomic_fixture SELECT g, repeat('x', 100) FROM generate_series(1, 200) g;
      `);
      const locker = await sql.reserve();
      try {
        // Hold the table so the backup stalls part-way through its data dump.
        await locker`BEGIN`;
        await locker`LOCK TABLE atomic_fixture IN ACCESS EXCLUSIVE MODE`;
        const pending = runDatabaseBackup({ connectionString, backupDir, retention, backupEngine: "javascript" });
        pending.catch(() => {});
        const blockedBackend = async () => {
          const rows = await sql<{ pid: number }[]>`
            SELECT pid FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND query ILIKE '%atomic_fixture%' AND pid <> pg_backend_pid()
          `;
          return rows[0]?.pid ?? null;
        };
        await waitFor(async () => (await blockedBackend()) !== null, "backup to block on the table lock");
        expect(partials(backupDir)).toHaveLength(1);
        expect(archives(backupDir)).toEqual([]);
        const pid = await blockedBackend();
        await sql`SELECT pg_terminate_backend(${pid})`;
        await expect(pending).rejects.toThrow();
        expect(archives(backupDir)).toEqual([]);
        expect(partials(backupDir)).toEqual([]);
      } finally {
        await locker`ROLLBACK`.catch(() => {});
        locker.release();
      }

      const result = await runDatabaseBackup({ connectionString, backupDir, retention, backupEngine: "javascript" });
      expect(archives(backupDir)).toEqual([path.basename(result.backupFile)]);
      expect(partials(backupDir)).toEqual([]);
      expect(gunzipSync(fs.readFileSync(result.backupFile)).toString()).toContain("atomic_fixture");
    } finally {
      await sql.end();
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});

describeEmbeddedPostgres("runDatabaseBackup", () => {
  it("preserves a post-pg_dump verification error without falling back or pruning", async () => {
    const connectionString = await createTempDatabase();
    const backupDir = createTempDir("checkpoint-pg-dump-");
    const executable = path.join(backupDir, "pg-dump-fixture");
    fs.writeFileSync(executable, "#!/bin/sh\nprintf 'SELECT 1;\\n'\n", { mode: 0o700 });
    const history = path.join(backupDir, "paperclip-history.sql.gz");
    const historyBytes = gzipSync("SELECT 'history';");
    fs.writeFileSync(history, historyBytes);
    fs.utimesSync(history, new Date(0), new Date(0));
    const previous = process.env.PAPERCLIP_PG_DUMP_PATH;
    process.env.PAPERCLIP_PG_DUMP_PATH = executable;
    const failure = new Error("fixture archive fsync failed");
    let verified = 0;
    try {
      await expect(runDatabaseBackup({
        connectionString, backupDir,
        retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
        verifyBeforePrune: async archive => {
          verified++;
          expect(gunzipSync(fs.readFileSync(archive)).toString()).toBe("SELECT 1;\n");
          throw failure;
        },
      })).rejects.toBe(failure);
      expect(verified).toBe(1);
      expect(fs.readFileSync(history)).toEqual(historyBytes);
      expect(fs.readdirSync(backupDir).filter(name => name.endsWith(".sql.gz"))).toEqual(["paperclip-history.sql.gz"]);
    } finally {
      if (previous === undefined) delete process.env.PAPERCLIP_PG_DUMP_PATH;
      else process.env.PAPERCLIP_PG_DUMP_PATH = previous;
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("preserves identity generation, sequence options and progress in JavaScript backups", async () => {
    const source = await createTempDatabase();
    const target = await createSiblingDatabase(source, "identity_restore_target");
    const sourceSql = postgres(source, { max: 1, onnotice: () => {} });
    const targetSql = postgres(target, { max: 1, onnotice: () => {} });
    try {
      await sourceSql.unsafe(`
        CREATE SCHEMA identity_fixture;
        CREATE TABLE identity_fixture.records (
          id bigint GENERATED ALWAYS AS IDENTITY (START WITH 7 INCREMENT BY 2) PRIMARY KEY,
          default_id integer GENERATED BY DEFAULT AS IDENTITY,
          value text NOT NULL
        );
        INSERT INTO identity_fixture.records (value) VALUES ('one'), ('two');
      `);
      const backup = await runDatabaseBackup({ connectionString: source, backupDir: createTempDir("identity-backup-"), backupEngine: "javascript", retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 } });
      await runDatabaseRestore({ connectionString: target, backupFile: backup.backupFile });
      expect(await targetSql`SELECT id::text, default_id, value FROM identity_fixture.records ORDER BY id`)
        .toEqual([{ id: "7", default_id: 1, value: "one" }, { id: "9", default_id: 2, value: "two" }]);
      expect(await targetSql`INSERT INTO identity_fixture.records (value) VALUES ('three') RETURNING id::text, default_id`)
        .toEqual([{ id: "11", default_id: 3 }]);
      await expect(targetSql`INSERT INTO identity_fixture.records (id, value) VALUES (99, 'explicit')`).rejects.toThrow("non-DEFAULT");
    } finally {
      await sourceSql.end();
      await targetSql.end();
    }
  }, 30_000);

  it(
    "keeps the newest backup for each retained calendar month",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const backupDir = createTempDir("paperclip-db-backup-retention-");
      const realDateNow = Date.now;
      Date.now = () => Date.UTC(2026, 2, 31, 12, 0, 0);

      const janNewest = path.join(backupDir, "paperclip-test-2026-01-28T12-00-00.sql.gz");
      const janOlder = path.join(backupDir, "paperclip-test-2026-01-10T12-00-00.sql.gz");
      const decOld = path.join(backupDir, "paperclip-test-2025-12-15T12-00-00.sql.gz");

      try {
        fs.writeFileSync(janNewest, "jan-newest");
        fs.writeFileSync(janOlder, "jan-older");
        fs.writeFileSync(decOld, "dec-old");

        fs.utimesSync(janNewest, new Date("2026-01-28T12:00:00Z"), new Date("2026-01-28T12:00:00Z"));
        fs.utimesSync(janOlder, new Date("2026-01-10T12:00:00Z"), new Date("2026-01-10T12:00:00Z"));
        fs.utimesSync(decOld, new Date("2025-12-15T12:00:00Z"), new Date("2025-12-15T12:00:00Z"));

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 2 },
          filenamePrefix: "paperclip-test",
        });

        expect(result.prunedCount).toBe(2);
        expect(fs.existsSync(janNewest)).toBe(true);
        expect(fs.existsSync(janOlder)).toBe(false);
        expect(fs.existsSync(decOld)).toBe(false);
      } finally {
        Date.now = realDateNow;
      }
    },
    30_000,
  );

  it(
    "backs up and restores large table payloads without materializing one giant string",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "paperclip_restore_target",
      );
      const backupDir = createTempDir("paperclip-db-backup-output-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });

      try {
        await sourceSql.unsafe(`
          CREATE TYPE "public"."backup_test_state" AS ENUM ('pending', 'done');
        `);
        await sourceSql.unsafe(`
          CREATE TABLE "public"."backup_test_records" (
            "id" serial PRIMARY KEY,
            "title" text NOT NULL,
            "payload" text NOT NULL,
            "state" "public"."backup_test_state" NOT NULL,
            "metadata" jsonb,
            "created_at" timestamptz NOT NULL DEFAULT now()
          );
        `);
        await sourceSql.unsafe(`
          CREATE FUNCTION "public"."backup_test_mark_done"()
          RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          BEGIN
            NEW."state" := 'done';
            RETURN NEW;
          END;
          $$;
          CREATE TRIGGER "backup_test_mark_done_trigger"
          BEFORE UPDATE OF "title" ON "public"."backup_test_records"
          FOR EACH ROW
          EXECUTE FUNCTION "public"."backup_test_mark_done"();
        `);

        const payload = "x".repeat(8192);
        for (let index = 0; index < 160; index += 1) {
          const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, index));
          await sourceSql`
            INSERT INTO "public"."backup_test_records" (
              "title",
              "payload",
              "state",
              "metadata",
              "created_at"
            )
            VALUES (
              ${`row-${index}`},
              ${payload},
              ${index % 2 === 0 ? "pending" : "done"}::"public"."backup_test_state",
              ${JSON.stringify({ index, even: index % 2 === 0 })}::jsonb,
              ${createdAt}
            )
          `;
        }

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-test",
          backupEngine: "javascript",
        });

        expect(result.backupFile).toMatch(/paperclip-test-.*\.sql\.gz$/);
        expect(result.sizeBytes).toBeGreaterThan(0);
        expect(fs.existsSync(result.backupFile)).toBe(true);

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile: result.backupFile,
        });

        const counts = await restoreSql.unsafe<{ count: number }[]>(`
          SELECT count(*)::int AS count
          FROM "public"."backup_test_records"
        `);
        expect(counts[0]?.count).toBe(160);

        const sampleRows = await restoreSql.unsafe<{
          title: string;
          payload: string;
          state: string;
          metadata: { index: number; even: boolean } | string;
        }[]>(`
          SELECT "title", "payload", "state"::text AS "state", "metadata"
          FROM "public"."backup_test_records"
          WHERE "title" IN ('row-0', 'row-159')
          ORDER BY "title"
        `);
        expect(sampleRows.map((row) => ({
          ...row,
          metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata,
        }))).toEqual([
          {
            title: "row-0",
            payload,
            state: "pending",
            metadata: { index: 0, even: true },
          },
          {
            title: "row-159",
            payload,
            state: "done",
            metadata: { index: 159, even: false },
          },
        ]);

        await restoreSql.unsafe(`
          UPDATE "public"."backup_test_records"
          SET "title" = 'triggered'
          WHERE "title" = 'row-0'
        `);
        const triggeredRows = await restoreSql.unsafe<{ state: string }[]>(`
          SELECT "state"::text AS "state"
          FROM "public"."backup_test_records"
          WHERE "title" = 'triggered'
        `);
        expect(triggeredRows).toEqual([{ state: "done" }]);
      } finally {
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    60_000,
  );

  it(
    "backs up and restores non-public database schemas and migration history",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "paperclip_full_logical_restore_target",
      );
      const backupDir = createTempDir("paperclip-db-full-logical-backup-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });

      try {
        await sourceSql.unsafe(`
          CREATE SCHEMA IF NOT EXISTS "drizzle";
          CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
            "id" serial PRIMARY KEY,
            "hash" text NOT NULL,
            "created_at" bigint
          );
          INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
          VALUES ('paperclip-migration-history', 1770000000000);
        `);
        await sourceSql.unsafe(`
          CREATE TABLE "public"."backup_parent_records" (
            "id" uuid PRIMARY KEY,
            "name" text NOT NULL
          );
          INSERT INTO "public"."backup_parent_records" ("id", "name")
          VALUES ('11111111-1111-4111-8111-111111111111', 'parent');
        `);
        await sourceSql.unsafe(`
          CREATE TABLE "public"."plugin_rows" (
            "id" serial PRIMARY KEY,
            "note" text NOT NULL
          );
          CREATE TABLE "public"."audit_rows" (
            "id" serial PRIMARY KEY,
            "secret_note" text
          );
          INSERT INTO "public"."plugin_rows" ("note")
          VALUES ('public-collision');
          INSERT INTO "public"."audit_rows" ("secret_note")
          VALUES ('public-secret');
        `);
        await sourceSql.unsafe(`
          CREATE SCHEMA "plugin_backup_scope";
          CREATE TYPE "plugin_backup_scope"."plugin_status" AS ENUM ('ready', 'done');
          CREATE TABLE "plugin_backup_scope"."plugin_rows" (
            "id" serial PRIMARY KEY,
            "parent_id" uuid NOT NULL REFERENCES "public"."backup_parent_records"("id") ON DELETE CASCADE,
            "status" "plugin_backup_scope"."plugin_status" NOT NULL,
            "note" text NOT NULL
          );
          CREATE TABLE "plugin_backup_scope"."audit_rows" (
            "id" serial PRIMARY KEY,
            "secret_note" text
          );
          CREATE UNIQUE INDEX "plugin_rows_note_uq" ON "plugin_backup_scope"."plugin_rows" ("note");
          INSERT INTO "plugin_backup_scope"."plugin_rows" ("parent_id", "status", "note")
            VALUES ('11111111-1111-4111-8111-111111111111', 'ready', 'first');
          INSERT INTO "plugin_backup_scope"."audit_rows" ("secret_note")
          VALUES ('plugin-secret');
        `);

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-full-logical-test",
          backupEngine: "javascript",
          excludeTables: ["plugin_rows"],
          nullifyColumns: {
            audit_rows: ["secret_note"],
          },
        });

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile: result.backupFile,
        });

        const migrationRows = await restoreSql.unsafe<{ hash: string }[]>(`
          SELECT "hash"
          FROM "drizzle"."__drizzle_migrations"
          WHERE "hash" = 'paperclip-migration-history'
        `);
        expect(migrationRows).toEqual([{ hash: "paperclip-migration-history" }]);

        const pluginRows = await restoreSql.unsafe<{ note: string; status: string; parent_name: string }[]>(`
          SELECT r."note", r."status"::text AS "status", p."name" AS "parent_name"
          FROM "plugin_backup_scope"."plugin_rows" r
          JOIN "public"."backup_parent_records" p ON p."id" = r."parent_id"
        `);
        expect(pluginRows).toEqual([{ note: "first", status: "ready", parent_name: "parent" }]);

        const publicCollisionRows = await restoreSql.unsafe<{ count: number }[]>(`
          SELECT count(*)::int AS count
          FROM "public"."plugin_rows"
        `);
        expect(publicCollisionRows[0]?.count).toBe(0);

        const publicAuditRows = await restoreSql.unsafe<{ secret_note: string | null }[]>(`
          SELECT "secret_note"
          FROM "public"."audit_rows"
        `);
        expect(publicAuditRows).toEqual([{ secret_note: null }]);

        const pluginAuditRows = await restoreSql.unsafe<{ secret_note: string | null }[]>(`
          SELECT "secret_note"
          FROM "plugin_backup_scope"."audit_rows"
        `);
        expect(pluginAuditRows).toEqual([{ secret_note: "plugin-secret" }]);

        await expect(
          restoreSql.unsafe(`
            INSERT INTO "plugin_backup_scope"."plugin_rows" ("parent_id", "status", "note")
            VALUES ('11111111-1111-4111-8111-111111111111', 'done', 'first')
          `),
        ).rejects.toThrow();
      } finally {
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    60_000,
  );

  it(
    "preserves composite foreign key column order without duplicate referenced columns",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "paperclip_composite_fk_restore_target",
      );
      const backupDir = createTempDir("paperclip-db-composite-fk-backup-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });

      try {
        await sourceSql.unsafe(`
          CREATE SCHEMA "plugin_composite_fk";
          CREATE TABLE "plugin_composite_fk"."content_cases" (
            "id" uuid PRIMARY KEY,
            "company_id" uuid NOT NULL,
            "title" text NOT NULL,
            CONSTRAINT "content_cases_company_case_unique" UNIQUE ("company_id", "id")
          );
          CREATE TABLE "plugin_composite_fk"."content_case_signals" (
            "company_id" uuid NOT NULL,
            "case_id" uuid NOT NULL,
            "signal" text NOT NULL,
            "scopes" text[] NOT NULL,
            "warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
            CONSTRAINT "content_case_signals_company_case"
              FOREIGN KEY ("company_id", "case_id")
              REFERENCES "plugin_composite_fk"."content_cases" ("company_id", "id")
              ON DELETE CASCADE
          );
          INSERT INTO "plugin_composite_fk"."content_cases" ("company_id", "id", "title")
          VALUES (
            '11111111-1111-4111-8111-111111111111',
            '22222222-2222-4222-8222-222222222222',
            'case'
          );
          INSERT INTO "plugin_composite_fk"."content_case_signals" ("company_id", "case_id", "signal", "scopes", "warnings")
          VALUES (
            '11111111-1111-4111-8111-111111111111',
            '22222222-2222-4222-8222-222222222222',
            'signal',
            ARRAY['upstream_import:preview', 'scope with space', 'quoted "scope"', 'NULL', 'null'],
            jsonb_build_array('json warning', jsonb_build_object('code', 'quoted "value"'))
          );
        `);

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-composite-fk-test",
          backupEngine: "javascript",
        });

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile: result.backupFile,
        });

        const rows = await restoreSql.unsafe<{
          signal: string;
          title: string;
          scopes: string[];
          warnings: Array<string | { code: string }>;
        }[]>(`
          SELECT s."signal", c."title", s."scopes", s."warnings"
          FROM "plugin_composite_fk"."content_case_signals" s
          JOIN "plugin_composite_fk"."content_cases" c
            ON c."company_id" = s."company_id"
           AND c."id" = s."case_id"
        `);
        expect(rows).toEqual([
          {
            signal: "signal",
            title: "case",
            scopes: ["upstream_import:preview", "scope with space", 'quoted "scope"', "NULL", "null"],
            warnings: ["json warning", { code: 'quoted "value"' }],
          },
        ]);

        await expect(
          restoreSql.unsafe(`
            INSERT INTO "plugin_composite_fk"."content_case_signals" ("company_id", "case_id", "signal", "scopes")
            VALUES (
              '11111111-1111-4111-8111-111111111111',
              '33333333-3333-4333-8333-333333333333',
              'orphan',
              ARRAY[]::text[]
            )
          `),
        ).rejects.toThrow();
      } finally {
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    60_000,
  );

  it(
    "restores fallback COPY data when child tables are dumped before parent tables",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "paperclip_copy_fk_restore_target",
      );
      const backupDir = createTempDir("paperclip-db-copy-fk-backup-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });
      const originalPgDumpPath = process.env.PAPERCLIP_PG_DUMP_PATH;
      const originalPsqlPath = process.env.PAPERCLIP_PSQL_PATH;
      process.env.PAPERCLIP_PG_DUMP_PATH = "/bin/false";
      process.env.PAPERCLIP_PSQL_PATH = "/bin/false";

      try {
        await sourceSql.unsafe(`
          CREATE TABLE "public"."zzz_parent_records" (
            "id" uuid PRIMARY KEY,
            "name" text NOT NULL
          );
          CREATE TABLE "public"."aaa_child_records" (
            "id" uuid PRIMARY KEY,
            "parent_id" uuid NOT NULL REFERENCES "public"."zzz_parent_records"("id") ON DELETE CASCADE,
            "note" text NOT NULL
          );
          INSERT INTO "public"."zzz_parent_records" ("id", "name")
          VALUES ('11111111-1111-4111-8111-111111111111', 'parent');
          INSERT INTO "public"."aaa_child_records" ("id", "parent_id", "note")
          VALUES (
            '22222222-2222-4222-8222-222222222222',
            '11111111-1111-4111-8111-111111111111',
            'child emitted before parent'
          );
        `);

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-copy-fk-test",
          backupEngine: "auto",
        });

        const backupSql = gunzipSync(await fs.promises.readFile(result.backupFile)).toString("utf8");
        expect(backupSql.indexOf("-- Data for: public.aaa_child_records")).toBeGreaterThan(-1);
        expect(backupSql.indexOf("-- Data for: public.aaa_child_records")).toBeLessThan(
          backupSql.indexOf("-- Data for: public.zzz_parent_records"),
        );
        expect(backupSql).not.toContain(" FROM stdin;");

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile: result.backupFile,
        });

        const rows = await restoreSql.unsafe<{ note: string; name: string }[]>(`
          SELECT child."note", parent."name"
          FROM "public"."aaa_child_records" child
          JOIN "public"."zzz_parent_records" parent ON parent."id" = child."parent_id"
        `);
        expect(rows).toEqual([{ note: "child emitted before parent", name: "parent" }]);
      } finally {
        if (originalPgDumpPath === undefined) {
          delete process.env.PAPERCLIP_PG_DUMP_PATH;
        } else {
          process.env.PAPERCLIP_PG_DUMP_PATH = originalPgDumpPath;
        }
        if (originalPsqlPath === undefined) {
          delete process.env.PAPERCLIP_PSQL_PATH;
        } else {
          process.env.PAPERCLIP_PSQL_PATH = originalPsqlPath;
        }
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    60_000,
  );

  it(
    "restores legacy public-only backups without migration history",
    async () => {
      const restoreConnectionString = await createTempDatabase();
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });
      const backupDir = createTempDir("paperclip-db-restore-manual-");
      const backupFile = path.join(backupDir, "manual.sql");

      try {
        await fs.promises.writeFile(
          backupFile,
          [
            "-- Paperclip database backup",
            "-- Created: 2026-04-06T00:00:00.000Z",
            "",
            "BEGIN;",
            "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
            "CREATE TABLE public.restore_stream_test (id integer primary key, payload text not null);",
            "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
            "INSERT INTO public.restore_stream_test (id, payload)",
            "VALUES (1, 'hello');",
            "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
            "COMMIT;",
            "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
          ].join("\n"),
          "utf8",
        );

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile,
        });

        const rows = await restoreSql.unsafe<{ payload: string }[]>(`
          SELECT payload
          FROM public.restore_stream_test
        `);
        expect(rows).toEqual([{ payload: "hello" }]);
      } finally {
        await restoreSql.end();
      }
    },
    20_000,
  );
  it(
    "streams JavaScript backups straight to gzip without an uncompressed file and restores them",
    async () => {
      const source = await createTempDatabase();
      const target = await createSiblingDatabase(source, "stream_restore_target");
      const sourceSql = postgres(source, { max: 1, onnotice: () => {} });
      const targetSql = postgres(target, { max: 1, onnotice: () => {} });
      const backupDir = createTempDir("paperclip-db-stream-");
      const seen = new Set<string>();
      const watcher = fs.watch(backupDir, (_event, name) => {
        if (name) seen.add(String(name));
      });
      const poll = setInterval(() => {
        for (const name of fs.readdirSync(backupDir)) seen.add(name);
      }, 5);
      try {
        await sourceSql.unsafe(`
          CREATE TABLE public.stream_rows (id integer PRIMARY KEY, payload text NOT NULL);
          INSERT INTO public.stream_rows
          SELECT g, repeat(md5(g::text), 8) FROM generate_series(1, 20000) AS g;
        `);
        const backup = await runDatabaseBackup({
          connectionString: source,
          backupDir,
          backupEngine: "javascript",
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
        });
        clearInterval(poll);
        watcher.close();
        for (const name of fs.readdirSync(backupDir)) seen.add(name);

        expect(backup.backupFile.endsWith(".sql.gz")).toBe(true);
        // Only the gzip archive, first under its temporary name, ever appears.
        expect([...seen].filter((name) => !name.endsWith(".sql.gz") && !name.endsWith(".sql.gz.partial"))).toEqual([]);
        expect(seen.has(`${path.basename(backup.backupFile)}.partial`)).toBe(true);
        expect(fs.readdirSync(backupDir)).toEqual([path.basename(backup.backupFile)]);
        const text = gunzipSync(fs.readFileSync(backup.backupFile)).toString("utf8");
        expect(text.startsWith("-- Paperclip database backup\n-- Created: ")).toBe(true);
        expect(text.endsWith("COMMIT;\n-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900\n")).toBe(true);

        await runDatabaseRestore({ connectionString: target, backupFile: backup.backupFile });
        expect(await targetSql`SELECT count(*)::int AS n, sum(length(payload))::int AS bytes FROM public.stream_rows`)
          .toEqual([{ n: 20000, bytes: 20000 * 256 }]);
      } finally {
        clearInterval(poll);
        watcher.close();
        await sourceSql.end();
        await targetSql.end();
      }
    },
    120_000,
  );

  it(
    "removes the partial archive and rethrows the original error when a JavaScript backup fails mid-stream",
    async () => {
      const source = await createTempDatabase();
      const sourceSql = postgres(source, { max: 1, onnotice: () => {} });
      const backupDir = createTempDir("paperclip-db-stream-fail-");
      try {
        await sourceSql.unsafe(`
          CREATE TABLE public.stream_rows (id integer PRIMARY KEY, payload text NOT NULL);
          INSERT INTO public.stream_rows
          SELECT g, repeat(md5(g::text), 8) FROM generate_series(1, 200000) AS g;
        `);
        let terminated = false;
        const killer = (async () => {
          const deadline = Date.now() + 60_000;
          while (Date.now() < deadline) {
            const archive = fs.readdirSync(backupDir).find((name) => name.endsWith(".sql.gz.partial"));
            if (archive && fs.statSync(path.join(backupDir, archive)).size > 0) {
              const rows = await sourceSql<{ pid: number }[]>`
                SELECT pg_terminate_backend(pid) AS ok, pid FROM pg_stat_activity
                WHERE datname = current_database() AND pid <> pg_backend_pid()
              `;
              terminated = rows.length > 0;
              return;
            }
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 2));
          }
        })();
        const failure = await runDatabaseBackup({
          connectionString: source,
          backupDir,
          backupEngine: "javascript",
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
        }).then(() => null, (error: unknown) => error);
        await killer;

        expect(terminated).toBe(true);
        expect(failure).toBeInstanceOf(Error);
        // postgres.js surfaces the server's admin-shutdown error (57P01) or the
        // dropped socket; either way it is the original driver error, not a
        // cleanup or stream error from the backup writer.
        expect(String((failure as Error).message)).not.toMatch(/stream|closed backup file/i);
        expect(fs.readdirSync(backupDir)).toEqual([]);
      } finally {
        await sourceSql.end();
      }
    },
    120_000,
  );
});
