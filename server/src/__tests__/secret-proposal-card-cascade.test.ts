import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  companySecretBindings,
  companySecretProposals,
  companySecretVersions,
  companySecrets,
  createDb,
  heartbeatRuns,
  issueComments,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { issueRoutes } from "../routes/issues.js";
import { secretRoutes } from "../routes/secrets.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// BLA-3351: accepting a "Confirm secret binding" card whose secret proposal
// was still pending failed with http_409 because the card accept path never
// cascaded. These tests drive the real issue-thread accept route.
describeEmbeddedPostgres("secret proposal card cascade", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-secret-card-cascade-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("secret-proposal-card-cascade");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(companySecretProposals);
    await db.delete(issueThreadInteractions);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function seedRun() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const reportId = randomUUID();
    const heartbeatRunId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Secret card cascade",
      issuePrefix: `C${companyId.slice(0, 7)}`.toUpperCase(),
      status: "active",
    });
    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "Proposer",
        role: "engineer",
        adapterType: "codex_local",
        adapterConfig: {},
        permissions: {},
        status: "idle",
      },
      {
        id: reportId,
        companyId,
        name: "Report",
        role: "engineer",
        reportsTo: agentId,
        adapterType: "codex_local",
        adapterConfig: {},
        permissions: {},
        status: "idle",
      },
    ]);
    await db.insert(heartbeatRuns).values({
      id: heartbeatRunId,
      companyId,
      agentId,
      status: "running",
      responsibleUserId: "user-1",
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Needs an SSH key",
      identifier: `${`C${companyId.slice(0, 7)}`.toUpperCase()}-1`,
      status: "in_progress",
      responsibleUserId: "user-1",
      executionRunId: heartbeatRunId,
    });
    return { companyId, agentId, reportId, heartbeatRunId, issueId };
  }

  type Fixture = Awaited<ReturnType<typeof seedRun>>;

  function agentApp(fixture: Fixture) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "agent",
        agentId: fixture.agentId,
        companyId: fixture.companyId,
        runId: fixture.heartbeatRunId,
        source: "agent_jwt",
        keyScope: { kind: "standard" },
      };
      next();
    });
    app.use("/api", secretRoutes(db));
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    return app;
  }

  function boardApp(fixture: Fixture, options: { admin?: boolean } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "board-user",
        companyIds: [fixture.companyId],
        source: options.admin === false ? "session" : "local_implicit",
        memberships: options.admin === false
          ? [{ companyId: fixture.companyId, status: "active", membershipRole: "member" }]
          : undefined,
      };
      next();
    });
    app.use("/api", secretRoutes(db));
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    return app;
  }

  async function proposeSecret(fixture: Fixture, name = "infra/light/training-ssh-ed25519") {
    const response = await request(agentApp(fixture)).post("/api/agents/me/secret-proposals").send({
      kind: "secret",
      name,
      key: "TRAINING_SSH_KEY",
      value: "-----BEGIN OPENSSH PRIVATE KEY----- fixture",
      justification: "Internal training host key",
    });
    expect(response.status).toBe(201);
    return response.body as { id: string };
  }

  async function proposeBinding(fixture: Fixture, secretProposalId: string, configPath: string, targetAgentId?: string) {
    const response = await request(agentApp(fixture)).post("/api/agents/me/secret-proposals").send({
      kind: "binding",
      secretProposalId,
      configPath,
      targetAgentId,
      justification: `Inject as ${configPath}`,
    });
    expect(response.status).toBe(201);
    return response.body as { id: string; interactionId: string };
  }

  async function cards(issueId: string) {
    return db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, issueId));
  }

  /** Rewrites a bundle card into the single-binding card shape that deployed builds raised. */
  async function toLegacyBindingCard(secretProposalId: string, bindingProposalId: string, interactionId: string) {
    const [card] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interactionId));
    const payload = card!.payload as unknown as Record<string, unknown>;
    const linked = payload.secretProposal as Record<string, unknown>;
    const { kind: _kind, bindings: _bindings, ...legacy } = linked;
    await db.update(issueThreadInteractions).set({
      title: "Confirm secret binding",
      payload: { ...payload, secretProposal: { ...legacy, proposalId: bindingProposalId } } as typeof card.payload,
    }).where(eq(issueThreadInteractions.id, interactionId));
    await db.update(companySecretProposals).set({ interactionId: null })
      .where(eq(companySecretProposals.id, secretProposalId));
  }

  it("regression: accepting a binding card whose secret proposal is pending cascades instead of failing 409", async () => {
    const fixture = await seedRun();
    const secret = await proposeSecret(fixture);
    const binding = await proposeBinding(fixture, secret.id, "env.TRAINING_SSH_KEY");
    // Reproduce today's card exactly: one card per binding, linked to the binding proposal.
    await toLegacyBindingCard(secret.id, binding.id, binding.interactionId);

    const accepted = await request(boardApp(fixture))
      .post(`/api/issues/${fixture.issueId}/interactions/${binding.interactionId}/accept`)
      .send({});
    expect(accepted.status).toBe(200);
    // Before the fix the card recorded { status: "failed", errorCode: "http_409" }.
    expect(accepted.body.result.secretProposal.errorCode ?? null).not.toBe("http_409");
    expect(accepted.body.result.secretProposal).toMatchObject({ status: "executed" });

    const proposals = await db.select().from(companySecretProposals);
    expect(proposals).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: secret.id, status: "approved", resolvedByUserId: "board-user" }),
      expect.objectContaining({ id: binding.id, status: "approved", appliedBindingConfigPath: "env.TRAINING_SSH_KEY" }),
    ]));
    const [created] = await db.select().from(companySecrets);
    expect(created).toMatchObject({ name: "infra/light/training-ssh-ed25519", createdByUserId: "board-user" });
    expect(await db.select().from(companySecretBindings)).toEqual([
      expect.objectContaining({ secretId: created.id, targetId: fixture.agentId, configPath: "env.TRAINING_SSH_KEY" }),
    ]);
    const decisions = (await db.select().from(activityLog)).filter((row) => row.action === "secret.proposal.card_approved");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.details).toMatchObject({
      interactionId: binding.interactionId,
      cascade: true,
      secretProposalId: secret.id,
      createdSecretId: created.id,
      bindingProposalIds: [binding.id],
    });
  });

  it("reports a legacy binding card with a pending secret as acceptable with cascade before the click", async () => {
    const fixture = await seedRun();
    const secret = await proposeSecret(fixture);
    const binding = await proposeBinding(fixture, secret.id, "env.TRAINING_SSH_KEY");
    await toLegacyBindingCard(secret.id, binding.id, binding.interactionId);
    const listed = await request(boardApp(fixture)).get(`/api/issues/${fixture.issueId}/interactions`);
    expect(listed.status).toBe(200);
    expect(listed.body.find((row: { id: string }) => row.id === binding.interactionId)).toMatchObject({
      secretProposalReadiness: { canAccept: true, blockReason: null, approvesSecret: true, bindingCount: 1 },
    });
  });

  it("raises one card for a secret proposal with several bindings and approves all of them in one decision", async () => {
    const fixture = await seedRun();
    const secret = await proposeSecret(fixture);
    const first = await proposeBinding(fixture, secret.id, "env.TRAINING_SSH_KEY");
    const second = await proposeBinding(fixture, secret.id, "env.TRAINING_SSH_KEY", fixture.reportId);
    const third = await proposeBinding(fixture, secret.id, "access.TRAINING_HOST");

    const issueCards = await cards(fixture.issueId);
    expect(issueCards).toHaveLength(1);
    const [card] = issueCards;
    expect(first.interactionId).toBe(card!.id);
    expect(second.interactionId).toBe(card!.id);
    expect(third.interactionId).toBe(card!.id);
    expect(card).toMatchObject({
      status: "pending",
      title: "Confirm new secret and bindings",
      payload: expect.objectContaining({
        secretProposal: expect.objectContaining({
          kind: "secret_with_bindings",
          proposalId: secret.id,
          sourceSecretLabel: "infra/light/training-ssh-ed25519",
          bindings: [
            expect.objectContaining({ proposalId: first.id, configPath: "env.TRAINING_SSH_KEY", targetAgentName: "Proposer" }),
            expect.objectContaining({ proposalId: second.id, configPath: "env.TRAINING_SSH_KEY", targetAgentName: "Report" }),
            expect.objectContaining({ proposalId: third.id, configPath: "access.TRAINING_HOST", targetAgentName: "Proposer" }),
          ],
        }),
      }),
    });
    expect(JSON.stringify(card!.payload)).not.toContain("BEGIN OPENSSH");
    const [secretRow] = await db.select().from(companySecretProposals).where(eq(companySecretProposals.id, secret.id));
    expect(secretRow!.interactionId).toBe(card!.id);

    const listed = await request(boardApp(fixture)).get(`/api/issues/${fixture.issueId}/interactions`);
    expect(listed.body[0].secretProposalReadiness).toEqual({
      canAccept: true,
      blockReason: null,
      approvesSecret: true,
      bindingCount: 3,
    });

    const accepted = await request(boardApp(fixture))
      .post(`/api/issues/${fixture.issueId}/interactions/${card!.id}/accept`)
      .send({});
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ status: "accepted", result: { secretProposal: { status: "executed" } } });

    const proposals = await db.select().from(companySecretProposals);
    expect(proposals).toHaveLength(4);
    expect(proposals.every((row) => row.status === "approved")).toBe(true);
    const [created] = await db.select().from(companySecrets);
    expect(await db.select().from(companySecrets)).toHaveLength(1);
    const bindings = await db.select().from(companySecretBindings);
    expect(bindings).toHaveLength(3);
    expect(bindings.every((row) => row.secretId === created!.id)).toBe(true);
    const [report] = await db.select().from(agents).where(eq(agents.id, fixture.reportId));
    expect(report!.adapterConfig).toMatchObject({
      env: { TRAINING_SSH_KEY: { type: "secret_ref", secretId: created!.id } },
    });
    const history = await db.select().from(activityLog);
    const decisions = history.filter((row) => row.action === "secret.proposal.card_approved");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.details).toMatchObject({
      cascade: true,
      secretProposalId: secret.id,
      bindingProposalIds: expect.arrayContaining([first.id, second.id, third.id]),
    });
    expect(history.filter((row) => row.action === "secret.proposal.approved")).toHaveLength(4);
    // One resolution comment for the whole decision.
    const resolutionComments = (await db.select().from(issueComments))
      .filter((row) => row.body.startsWith("Secret proposal resolution"));
    expect(resolutionComments).toHaveLength(1);
  });

  it("rejecting the one card rejects the secret proposal and all its bindings", async () => {
    const fixture = await seedRun();
    const secret = await proposeSecret(fixture);
    const first = await proposeBinding(fixture, secret.id, "env.TRAINING_SSH_KEY");
    const second = await proposeBinding(fixture, secret.id, "env.TRAINING_SSH_KEY", fixture.reportId);

    const rejected = await request(boardApp(fixture))
      .post(`/api/issues/${fixture.issueId}/interactions/${first.interactionId}/reject`)
      .send({ reason: "Use the vault-managed key instead" });
    expect(rejected.status).toBe(200);
    expect(rejected.body).toMatchObject({ status: "rejected" });

    const proposals = await db.select().from(companySecretProposals);
    expect(proposals).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: secret.id, status: "rejected", valueCiphertext: null }),
      expect.objectContaining({ id: first.id, status: "rejected" }),
      expect.objectContaining({ id: second.id, status: "rejected" }),
    ]));
    expect(await db.select().from(companySecrets)).toHaveLength(0);
    expect(await db.select().from(companySecretBindings)).toHaveLength(0);
  });

  it("shows why the cascade is not allowed before the click and refuses accept without a 409", async () => {
    const fixture = await seedRun();
    const secret = await proposeSecret(fixture);
    const binding = await proposeBinding(fixture, secret.id, "env.TRAINING_SSH_KEY");
    const now = new Date();
    await db.insert(authUsers).values({
      id: "board-user",
      name: "Board member",
      email: "board-member@example.com",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(companyMemberships).values({
      companyId: fixture.companyId,
      principalType: "user",
      principalId: "board-user",
      status: "active",
      membershipRole: "member",
    });
    const member = boardApp(fixture, { admin: false });

    const listed = await request(member).get(`/api/issues/${fixture.issueId}/interactions`);
    expect(listed.status).toBe(200);
    expect(listed.body[0].secretProposalReadiness).toMatchObject({
      canAccept: false,
      approvesSecret: true,
      blockReason: expect.stringContaining("owner or admin access is required"),
    });

    const accepted = await request(member)
      .post(`/api/issues/${fixture.issueId}/interactions/${binding.interactionId}/accept`)
      .send({});
    expect(accepted.status).not.toBe(409);
    expect(accepted.status).toBe(422);
    expect(accepted.body.error).toContain("owner or admin access is required");
    // The card stays pending and nothing was approved.
    expect((await cards(fixture.issueId))[0]).toMatchObject({ status: "pending" });
    expect((await db.select().from(companySecretProposals)).every((row) => row.status === "pending")).toBe(true);
    expect(await db.select().from(companySecrets)).toHaveLength(0);
  });

  it("shows a terminal secret proposal on a legacy binding card before the click", async () => {
    const fixture = await seedRun();
    const secret = await proposeSecret(fixture);
    const binding = await proposeBinding(fixture, secret.id, "env.TRAINING_SSH_KEY");
    await toLegacyBindingCard(secret.id, binding.id, binding.interactionId);
    // A legacy single-binding card whose secret proposal was withdrawn but whose
    // binding was not cascaded (pre-fix data).
    await db.update(companySecretProposals).set({ status: "withdrawn" })
      .where(eq(companySecretProposals.id, secret.id));

    const listed = await request(boardApp(fixture)).get(`/api/issues/${fixture.issueId}/interactions`);
    expect(listed.body[0].secretProposalReadiness).toMatchObject({
      canAccept: false,
      blockReason: expect.stringContaining("withdrawn by the agent"),
    });
    const accepted = await request(boardApp(fixture))
      .post(`/api/issues/${fixture.issueId}/interactions/${binding.interactionId}/accept`)
      .send({});
    expect(accepted.status).toBe(422);
    expect((await cards(fixture.issueId))[0]).toMatchObject({ status: "pending" });
    expect(await db.select().from(companySecrets)).toHaveLength(0);
  });

  it("does not let an agent approve its own proposal from the card or the Proposals endpoint", async () => {
    const fixture = await seedRun();
    const secret = await proposeSecret(fixture);
    const binding = await proposeBinding(fixture, secret.id, "env.TRAINING_SSH_KEY");

    const viaCard = await request(agentApp(fixture))
      .post(`/api/issues/${fixture.issueId}/interactions/${binding.interactionId}/accept`)
      .send({});
    expect(viaCard.status).toBeGreaterThanOrEqual(400);
    const viaProposals = await request(agentApp(fixture))
      .post(`/api/companies/${fixture.companyId}/secret-proposals/${secret.id}/approve`)
      .send({ cascade: true });
    expect(viaProposals.status).toBe(403);

    expect((await cards(fixture.issueId))[0]).toMatchObject({ status: "pending" });
    expect((await db.select().from(companySecretProposals)).every((row) => row.status === "pending")).toBe(true);
    expect(await db.select().from(companySecrets)).toHaveLength(0);
  });

  it("keeps the single-binding card for a binding added after the secret was approved", async () => {
    const fixture = await seedRun();
    const secret = await proposeSecret(fixture);
    const first = await proposeBinding(fixture, secret.id, "env.TRAINING_SSH_KEY");
    expect((await request(boardApp(fixture))
      .post(`/api/issues/${fixture.issueId}/interactions/${first.interactionId}/accept`)
      .send({})).status).toBe(200);
    const [created] = await db.select().from(companySecrets);

    const later = await request(agentApp(fixture)).post("/api/agents/me/secret-proposals").send({
      kind: "binding",
      secretId: created!.id,
      configPath: "access.TRAINING_HOST",
      justification: "Second consumer",
    });
    expect(later.status).toBe(201);
    const [laterCard] = await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, later.body.interactionId));
    expect(laterCard).toMatchObject({
      title: "Confirm secret binding",
      payload: expect.objectContaining({
        secretProposal: expect.objectContaining({ proposalId: later.body.id, configPath: "access.TRAINING_HOST" }),
      }),
    });
    expect((laterCard!.payload as { secretProposal: { kind?: string } }).secretProposal.kind).toBeUndefined();

    const listed = await request(boardApp(fixture)).get(`/api/issues/${fixture.issueId}/interactions`);
    expect(listed.body.find((row: { id: string }) => row.id === laterCard!.id).secretProposalReadiness)
      .toMatchObject({ canAccept: true, approvesSecret: false, bindingCount: 1 });
    const accepted = await request(boardApp(fixture))
      .post(`/api/issues/${fixture.issueId}/interactions/${laterCard!.id}/accept`)
      .send({});
    expect(accepted.status).toBe(200);
    expect(accepted.body.result.secretProposal).toMatchObject({ status: "executed" });
    expect(await db.select().from(companySecretBindings)).toHaveLength(2);
  });

  it("resolves the bundle card once the secret and its bindings were approved on Secrets › Proposals", async () => {
    const fixture = await seedRun();
    const secret = await proposeSecret(fixture);
    const binding = await proposeBinding(fixture, secret.id, "env.TRAINING_SSH_KEY");

    const approvedSecret = await request(boardApp(fixture))
      .post(`/api/companies/${fixture.companyId}/secret-proposals/${secret.id}/approve`)
      .send({});
    expect(approvedSecret.status).toBe(200);
    // The secret alone does not resolve the card: its binding still waits.
    expect((await cards(fixture.issueId))[0]).toMatchObject({ status: "pending" });
    const listed = await request(boardApp(fixture)).get(`/api/issues/${fixture.issueId}/interactions`);
    expect(listed.body[0].secretProposalReadiness)
      .toMatchObject({ canAccept: true, approvesSecret: false, bindingCount: 1 });

    const approvedBinding = await request(boardApp(fixture))
      .post(`/api/companies/${fixture.companyId}/secret-proposals/${binding.id}/approve`)
      .send({});
    expect(approvedBinding.status).toBe(200);
    expect((await cards(fixture.issueId))[0]).toMatchObject({
      status: "accepted",
      result: expect.objectContaining({ secretProposal: expect.objectContaining({ status: "executed" }) }),
    });
  });
});
