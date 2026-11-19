// BLA-433: embedded PostgreSQL password from PAPERCLIP_EMBEDDED_POSTGRES_PASSWORD_FILE.
// Ported from bla433 tests/db-password.test.mjs. The cluster tests run on a
// SCRATCH cluster (embedded binaries, scratch data dir, free port, dummy
// password) and never touch an instance DB. The stage-D rotation uses a SCRAM
// verifier computed in the test; the host tool (pc-pg-scram-verifier) is an
// operator artefact outside this repository.
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  __resetEmbeddedPostgresPasswordCacheForTests,
  embeddedPostgresPassword,
  embeddedPostgresPasswordUri,
} from "./embedded-postgres-password.js";
import { resolveMigrationConnection } from "./migration-runtime.js";
import { getEmbeddedPostgresTestSupport } from "./test-embedded-postgres.js";

const ENV_KEYS = ["PAPERCLIP_EMBEDDED_POSTGRES_PASSWORD_FILE", "PAPERCLIP_CONFIG", "DATABASE_URL"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function restoreEnv() {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  __resetEmbeddedPostgresPasswordCacheForTests();
}

function scratchDir(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function freePort(): Promise<number> {
  return await new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

function writeScratchConfig(root: string, port: number) {
  const cfg = path.join(root, "config.json");
  fs.writeFileSync(cfg, JSON.stringify({
    database: { mode: "embedded-postgres", embeddedPostgresDataDir: path.join(root, "db"), embeddedPostgresPort: port },
  }));
  return cfg;
}

/** RFC 5802 / PostgreSQL SCRAM-SHA-256 verifier, so no plaintext travels in SQL. */
function scramSha256Verifier(password: string, iterations = 4096) {
  const salt = crypto.randomBytes(16);
  const salted = crypto.pbkdf2Sync(password.normalize("NFKC"), salt, iterations, 32, "sha256");
  const clientKey = crypto.createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = crypto.createHash("sha256").update(clientKey).digest();
  const serverKey = crypto.createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

afterEach(() => restoreEnv());

describe("embeddedPostgresPassword", () => {
  it("unset: legacy password (stage A, inert)", () => {
    delete process.env.PAPERCLIP_EMBEDDED_POSTGRES_PASSWORD_FILE;
    __resetEmbeddedPostgresPasswordCacheForTests();
    expect(embeddedPostgresPassword()).toBe("paperclip");
    expect(embeddedPostgresPasswordUri()).toBe("paperclip");
  });

  it("set: reads the file, strips one trailing newline, URI-encodes", () => {
    const root = scratchDir("bla433-pw-");
    try {
      const file = path.join(root, "pw");
      fs.writeFileSync(file, "dummy/+@ pw\n", { mode: 0o600 });
      process.env.PAPERCLIP_EMBEDDED_POSTGRES_PASSWORD_FILE = file;
      __resetEmbeddedPostgresPasswordCacheForTests();
      expect(embeddedPostgresPassword()).toBe("dummy/+@ pw");
      expect(embeddedPostgresPasswordUri()).toBe(encodeURIComponent("dummy/+@ pw"));
      // cached for the process lifetime
      fs.writeFileSync(file, "changed\n");
      expect(embeddedPostgresPassword()).toBe("dummy/+@ pw");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("set but empty, malformed or unreadable: fails closed (no legacy fallback)", () => {
    const root = scratchDir("bla433-pw-");
    try {
      for (const [name, body] of [["empty", ""], ["newline-only", "\n"], ["two-lines", "a\nb\n"], ["cr", "a\rb"]] as const) {
        const file = path.join(root, name);
        fs.writeFileSync(file, body, { mode: 0o600 });
        process.env.PAPERCLIP_EMBEDDED_POSTGRES_PASSWORD_FILE = file;
        __resetEmbeddedPostgresPasswordCacheForTests();
        expect(() => embeddedPostgresPassword(), name).toThrow(/empty or malformed/);
      }
      process.env.PAPERCLIP_EMBEDDED_POSTGRES_PASSWORD_FILE = path.join(root, "missing");
      __resetEmbeddedPostgresPasswordCacheForTests();
      expect(() => embeddedPostgresPassword()).toThrow(/ENOENT/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("migration runtime fails closed before starting a cluster when the file is empty", async () => {
    const root = scratchDir("bla433-pg2-");
    try {
      const port = await freePort();
      process.env.PAPERCLIP_CONFIG = writeScratchConfig(root, port);
      delete process.env.DATABASE_URL;
      const empty = path.join(root, "pw");
      fs.writeFileSync(empty, "", { mode: 0o600 });
      process.env.PAPERCLIP_EMBEDDED_POSTGRES_PASSWORD_FILE = empty;
      __resetEmbeddedPostgresPasswordCacheForTests();
      await expect(resolveMigrationConnection()).rejects.toThrow(/empty or malformed/);
      expect(fs.existsSync(path.join(root, "db")), "no cluster was initialised").toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describeCluster = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping embedded-PG password cluster tests: ${support.reason ?? "unsupported environment"}`);
}

describeCluster("embedded cluster with a file password (scratch cluster)", () => {
  beforeAll(() => {
    delete process.env.DATABASE_URL;
  });

  it("cluster initialised and reached with the file password; legacy password rejected", async () => {
    const root = scratchDir("bla433-pg-");
    const port = await freePort();
    expect(port).not.toBe(54329);
    process.env.PAPERCLIP_CONFIG = writeScratchConfig(root, port);
    delete process.env.DATABASE_URL;
    const pwFile = path.join(root, "pw");
    const dummy = `dummy-${crypto.randomBytes(9).toString("base64url")}/+@`;
    fs.writeFileSync(pwFile, `${dummy}\n`, { mode: 0o600 });
    process.env.PAPERCLIP_EMBEDDED_POSTGRES_PASSWORD_FILE = pwFile;
    __resetEmbeddedPostgresPasswordCacheForTests();
    const conn = await resolveMigrationConnection();
    try {
      expect(conn.connectionString).not.toContain("paperclip:paperclip@");
      expect(conn.connectionString).toContain(encodeURIComponent(dummy));
      const good = postgres(conn.connectionString, { max: 1, connect_timeout: 10 });
      expect((await good`select 1 as x`)[0]?.x).toBe(1);
      await good.end({ timeout: 2 });
      const legacy = postgres(`postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`, { max: 1, connect_timeout: 10 });
      await expect(legacy`select 1`).rejects.toMatchObject({ code: "28P01" });
      await legacy.end({ timeout: 2 });
    } finally {
      await conn.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it("m1: stage-D rotation with a client-side SCRAM verifier (no plaintext in SQL)", async () => {
    const root = scratchDir("bla433-pg3-");
    const port = await freePort();
    process.env.PAPERCLIP_CONFIG = writeScratchConfig(root, port);
    delete process.env.DATABASE_URL;
    const pwFile = path.join(root, "pw");
    fs.writeFileSync(pwFile, `dummy-${crypto.randomBytes(9).toString("base64url")}\n`, { mode: 0o600 });
    process.env.PAPERCLIP_EMBEDDED_POSTGRES_PASSWORD_FILE = pwFile;
    __resetEmbeddedPostgresPasswordCacheForTests();
    const conn = await resolveMigrationConnection();
    try {
      const nextValue = `dummy2-${crypto.randomBytes(12).toString("base64url")}`;
      const verifier = scramSha256Verifier(nextValue);
      expect(verifier).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
      expect(verifier).not.toContain(nextValue);
      const sql = postgres(conn.connectionString, { max: 1, connect_timeout: 10 });
      await sql.unsafe(`ALTER ROLE paperclip PASSWORD '${verifier}'`);
      await sql.end({ timeout: 2 });
      const rotated = postgres(`postgres://paperclip:${encodeURIComponent(nextValue)}@127.0.0.1:${port}/paperclip`, { max: 1, connect_timeout: 10 });
      expect((await rotated`select 1 as x`)[0]?.x).toBe(1);
      await rotated.end({ timeout: 2 });
      const old = postgres(conn.connectionString, { max: 1, connect_timeout: 10 });
      await expect(old`select 1`).rejects.toMatchObject({ code: "28P01" });
      await old.end({ timeout: 2 });
    } finally {
      await conn.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
