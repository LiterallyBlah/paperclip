#!/usr/bin/env node
/**
 * One-shot operator import of an approved OAuth grant (JSON company secret)
 * into a Paperclip-managed shared MCP connection, then agent-only scoping.
 *
 * Runs on the host as the Paperclip service user against a deployed release's
 * own `dist` modules. The import logic is `server/src/services/tool-oauth-grant-import.ts`,
 * emitted to JS and placed in a directory whose `node_modules` is a symlink to
 * the release's `node_modules`, so `drizzle-orm` and `@paperclipai/db` resolve
 * to the exact modules the server runs.
 *
 * Never prints, logs, writes or passes in argv any credential value. Without
 * --apply it only runs read-only preflight checks and never reads the secret.
 *
 *   node import-oauth-grant-connection.mjs --core <dir>/tool-oauth-grant-import.js \
 *     --company <id> --source-secret <id> --source-version 1 --provider buffer \
 *     --application-key buffer-mcp --application-name Buffer --connection-name "Buffer (CMO only, read-only)" \
 *     --expected-resource https://mcp.example/mcp --agent <id> --instructions-file <path> \
 *     [--step import|scope|all] [--connection <id>] [--apply]
 *
 * DATABASE_URL must point at the instance database.
 */
import { readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    release: { type: "string", default: "/opt/paperclip/app" },
    core: { type: "string" },
    company: { type: "string" },
    "source-secret": { type: "string" },
    "source-version": { type: "string", default: "1" },
    provider: { type: "string" },
    "application-key": { type: "string" },
    "application-name": { type: "string" },
    "connection-name": { type: "string" },
    "expected-resource": { type: "string" },
    agent: { type: "string" },
    "instructions-file": { type: "string" },
    connection: { type: "string" },
    provenance: { type: "string" },
    step: { type: "string", default: "all" },
    apply: { type: "boolean", default: false },
  },
});

function fail(message, code = "usage") {
  process.stdout.write(`${JSON.stringify({ ok: false, code, message })}\n`);
  process.exit(1);
}
const need = (name) => args[name] ?? fail(`--${name} is required`);
if (!["import", "scope", "all"].includes(args.step)) fail("--step must be import, scope or all");
if (!process.env.DATABASE_URL) fail("DATABASE_URL is required");

const release = await realpath(args.release);
const releaseModules = await realpath(join(release, "node_modules"));
const corePath = await realpath(need("core"));
if (await realpath(join(dirname(corePath), "node_modules")).catch(() => null) !== releaseModules) {
  fail("The core module's node_modules must link to the release's node_modules");
}
const dist = join(releaseModules, "@paperclipai/server/dist/services");
const load = (path) => import(pathToFileURL(path).href);
const [{ sql }, { createDb }, { secretService }, { writeConnectionCredential }, { syncConnectionCredentialBindings },
  { createOrganizationGrantStore }, { toolAccessService }, core] = await Promise.all([
  load(join(releaseModules, "drizzle-orm/index.js")),
  load(join(releaseModules, "@paperclipai/db/dist/index.js")),
  load(join(dist, "secrets.js")),
  load(join(dist, "connection-credentials.js")),
  load(join(dist, "connection-credential-bindings.js")),
  load(join(dist, "tool-access/connections/organization-grant.js")),
  load(join(dist, "tool-access.js")),
  load(corePath),
]);

const db = createDb(process.env.DATABASE_URL);
const companyId = need("company");
const out = { ok: true, release, step: args.step, apply: args.apply };
try {
  const runImport = args.step === "import" || args.step === "all";
  const runScope = args.step === "scope" || args.step === "all";
  const agentId = runScope ? need("agent") : null;
  const instructions = runScope ? (await readFile(need("instructions-file"), "utf8")).trim() : null;
  if (runScope && !instructions) fail("The instructions file is empty");

  const sourceSecretId = runImport ? need("source-secret") : null;
  const importInput = runImport ? {
    companyId, sourceSecretId, sourceSecretVersion: Number(args["source-version"]),
    provider: need("provider"), applicationKey: need("application-key"), applicationName: need("application-name"),
    connectionName: need("connection-name"), expectedResource: args["expected-resource"] ?? null,
    provenance: args.provenance ?? null,
  } : null;

  // Read-only preflight: metadata only, never the secret value.
  const source = sourceSecretId ?? "00000000-0000-0000-0000-000000000000";
  const pre = await db.execute(sql`select
      (select json_build_object('status', status, 'scope', scope, 'latestVersion', latest_version)
        from company_secrets where id = ${source} and company_id = ${companyId}) as source,
      (select count(*)::int from secret_access_events where secret_id = ${source}
        and config_path = ${core.OAUTH_GRANT_IMPORT_CONFIG_PATH} and outcome = 'success') as prior_import_reads,
      (select count(*)::int from tool_connections where company_id = ${companyId}
        and config -> 'oauthImport' ->> 'sourceSecretId' = ${source}) as marked_connections,
      (select count(*)::int from tool_applications where company_id = ${companyId}
        and application_key = ${importInput?.applicationKey ?? ""}) as applications,
      (select count(*)::int from tool_connections where company_id = ${companyId} and status <> 'archived'
        and config ->> 'url' = ${args["expected-resource"] ?? ""}) as url_connections,
      (select count(*)::int from agents where company_id = ${companyId} and id::text = ${agentId ?? ""}) as agent`);
  out.preflight = (Array.isArray(pre) ? pre : pre.rows)[0];

  if (!args.apply) {
    out.note = "Preflight only. Re-run with --apply to import and scope.";
  } else {
    let connectionId = args.connection ?? null;
    if (runImport) {
      const result = await core.importOAuthGrantConnection(db, importInput, {
        secretService, writeConnectionCredential, syncConnectionCredentialBindings, createOrganizationGrantStore,
      });
      connectionId = result.connectionId;
      out.import = result;
    }
    if (runScope) {
      if (!connectionId) fail("--connection is required for --step scope");
      const toolAccess = toolAccessService(db, { deploymentMode: "authenticated", deploymentExposure: "private" });
      out.scope = await core.scopeImportedConnectionToAgent(db, {
        companyId, connectionId, agentId, agentInstructions: instructions,
      }, { toolAccess });
    }
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
} catch (error) {
  // Error text from the import is value-free by construction; print only code and message.
  process.stdout.write(`${JSON.stringify({ ...out, ok: false, code: error?.code ?? error?.details?.code ?? "error", message: String(error?.message ?? error) })}\n`);
  process.exitCode = 1;
} finally {
  await db.$client?.end?.({ timeout: 5 }).catch(() => undefined);
}
