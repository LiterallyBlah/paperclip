# Maintained downstream: Paperclip

This fork preserves a small, explicit patch set while incorporating upstream releases. It is not a replacement implementation of Paperclip.

- Owned repository: https://github.com/LiterallyBlah/paperclip
- Maintained branch: `blahsec-integration`
- Vendor repository (`upstream`): https://github.com/paperclipai/paperclip
- Vendor default branch at bootstrap: `master`; rediscover it rather than assuming `main`.
- Initial vendor baseline: `1b4c803816e82b0265c8422e1a804327a7ed8c54`.
- `origin` means the owned fork. `upstream` means the vendor. Verify URLs before fetching or pushing.

## Update contract

**Merge upstream into a candidate based on our maintained branch. Never replace the maintained branch or deployed files with a stock release.** Do not use force-sync/reset operations to make this fork identical to upstream. A fork is not maintained merely because its default branch matches the vendor.

Updates are owner-requested, not an unattended deployment schedule. No registry publication, public exposure, account migration or paid live test is implied by an update.

1. Inspect the current worktree, remotes, deployed revision and previous verification. Preserve unrelated edits; use a separate worktree for the candidate. Never automatically stash, reset, clean, or commit someone else's work.
2. Fetch `origin` and `upstream`. Select the exact upstream release/tag/commit deliberately. Read its release notes and relevant migrations. Create an `update/<release>` branch from `origin/blahsec-integration`, then merge that exact upstream ref into it. Resolve conflicts by preserving required behaviour, not by choosing one whole tree.
3. Review the patch ledger below against the new upstream implementation. Retire a patch only when the equivalent behaviour passes its acceptance checks, including security and saved-data compatibility. A matching provider name alone is not equivalence.
4. Install the locked dependencies using the repository's required Node/pnpm versions. Run focused tests first, then the release checks required by `AGENTS.md`: `pnpm -r typecheck`, `pnpm test:run`, and `pnpm build`. Record actual failures and skipped checks. Do not weaken checks to make the upgrade pass. Reuse qualified runner/build artefacts only when their source, dependencies and relevant environment are unchanged, and record the provenance.
5. Rehearse migrations against an isolated copy of representative data with its corresponding encryption configuration. Never run the candidate's first migration experiment against production. Reconcile custom migration ordering/journal/snapshots with newly added vendor migrations. The original `0334_muse_subscription_provider.sql` may collide numerically with a later vendor migration; do not renumber already-applied production history blindly.
6. Build a complete installable candidate from the merged source and locked dependencies, using the repository's packaging tooling without publishing it. Stage it as a new immutable release, retaining the current release. Do not incrementally overlay arbitrary upstream files onto production.
7. Verify the staged adapters, private/authenticated HTTP behaviour and the acceptance checks below. With fresh verified backups available, promote the tested commit to `blahsec-integration`, push and read back the remote SHA, then activate the staged release. Verify the exact live build revision, health and agent configuration after activation.
8. Keep a compatible prior code/data combination for rollback. A symlink rollback alone may be insufficient after database migrations. Do not delete rollback material as part of an ordinary update.

Example source preparation (substitute an explicitly selected upstream ref and an unused candidate path):

```sh
git remote -v
git fetch origin
git fetch upstream --tags
git worktree add -b update/RELEASE ../paperclip-update-RELEASE origin/blahsec-integration
cd ../paperclip-update-RELEASE
git merge --no-ff UPSTREAM_REF
# Resolve, inspect, build, test and stage before promoting anything.
```

## Patch ledger and retirement criteria

| Patch | Origin | Required behaviour / retirement condition |
| --- | --- | --- |
| `12f1d265a27db268eabd267cfbd6d9a56b8ab1b7` | Backport of vendor PR #17845 plus integration corrections | Muse Code is a native provider/adapter with subscription OAuth, correct provider/default constraints, connection selection and browser-safe UI imports. Re-check https://github.com/paperclipai/paperclip/pull/17845 when updating. |
| `b17b34d10cd29abe4cb5318c220bc17d8b1af072` | Downstream browser fix | Muse subscription connection renders Meta approval, not a Codex terminal fallback; pending/retry/error states and disabled Connect are correct. |
| `c209547617f2f9e621f8dfdcd3e9e02646bae5a9` | Downstream native Muse compatibility/security | Native Muse login uses attempt-private HOME/XDG paths; completion requires verified active subscription OAuth credentials, not an output string. Ambient Meta/Muse API keys cannot select metered billing or another account. |
| `5c88ea00c28e6519b0d66f4f97b858ac293932e9` | Downstream shared SSH and Hermes environment support | Command, run environment and stdin use private SSH framing, never bearer-containing argv; preserve streaming, EOF, remote profile precedence and cleanup. Hermes supports native managed instructions/skills and local/SSH environments. |

Keep subsequent gateway-aware adapter changes in focused commits and add them here with their matching Hermes capability and acceptance evidence. Do not remove adapter support merely because the vendor already has a similarly named adapter.

## v2026.1106.0 line (`blahsec-integration-1106`)

The live release, `stock-2026.1106.0-bla120-f063cc21-qwake-c03c79d4-signin-6f18750d`, is vendor tag `v2026.1106.0` (`d69631b01b`) plus the three fixes below, in this order. It does **not** contain the Muse/Hermes patches in the table above; those exist only on `blahsec-integration`, which does not contain `v2026.1106.0`. Merging this line into `blahsec-integration` conflicts in the migration journal, the AI provider/connection defaults and the app definitions, so this line is kept on its own base branch, `blahsec-integration-1106`, created from the tag. Reconciling the two lines (carrying the Muse/Hermes patches onto 1106 or later) is a separate, owner-approved update that follows the contract above.

Policy for each local fix: search vendor issues and pull requests first. If a vendor pull request already fixes the problem, carry our patch only until that pull request (or an equivalent) is released; otherwise open our own vendor pull request. Retire a patch only when the vendor release passes the acceptance check listed for it.

| Patch | Problem | Vendor change that replaces it | Retire when |
| --- | --- | --- | --- |
| `4c17875f93` (installed as `f063cc21`) | A question card addressed to an agent that is not the issue assignee is woken with `interaction_pending` and no comment id. The queued-run ownership gate cancels that run as `issue_assignee_changed`, so the addressee never answers. | Open PR https://github.com/paperclipai/paperclip/pull/15991 (also https://github.com/paperclipai/paperclip/pull/14378, https://github.com/paperclipai/paperclip/pull/16914, https://github.com/paperclipai/paperclip/pull/17643). Issues https://github.com/paperclipai/paperclip/issues/11932, https://github.com/paperclipai/paperclip/issues/13518, https://github.com/paperclipai/paperclip/issues/16409, https://github.com/paperclipai/paperclip/issues/19620. | A released vendor version runs the addressee's `interaction_pending` wake (no `issue_assignee_changed` cancel) while still cancelling wakes for a resolved, dismissed, readdressed, foreign-company or malformed card. `c03c79d470` supersedes this patch's logic, so retire both together. |
| `c03c79d470` | Same problem, end to end: the addressee must also pass the review-participant and dependency gates, and its prompt must say "answer the card", not "work the assigned task" (otherwise checkout returns 409 and the card is never answered). | Ownership/review-participant gate: https://github.com/paperclipai/paperclip/pull/15991. Answer-only prompt: https://github.com/paperclipai/paperclip/pull/18907 (issue https://github.com/paperclipai/paperclip/issues/16563). Dependency gate: our PR https://github.com/paperclipai/paperclip/pull/20806 (issue https://github.com/paperclipai/paperclip/issues/20652). Not covered by this patch or upstream: the deferral behind a live run, https://github.com/paperclipai/paperclip/issues/20256. | All three vendor changes (or equivalents) are released, and a question addressed to a non-assignee agent on a blocked issue is answered by that agent without checking out the issue or changing its assignee. |
| `ac07dc9e8c` + `6f18750dcd` | The Claude login-prompt detector scans the whole raw transcript, including tool output. A successful run killed by terminal-result cleanup (exit 143) whose tool output contains words such as "unauthorized" or "not logged in" is labelled `claude_auth_required`, and the shared AI connection is marked `needs_reauthorization`. | Open PR https://github.com/paperclipai/paperclip/pull/15660 (closest match; alternatives https://github.com/paperclipai/paperclip/pull/13647, https://github.com/paperclipai/paperclip/pull/17229, https://github.com/paperclipai/paperclip/pull/11052; complementary failed-run gate https://github.com/paperclipai/paperclip/pull/14089). Issues https://github.com/paperclipai/paperclip/issues/5534, https://github.com/paperclipai/paperclip/issues/15441. | A released vendor version does not label a successful or cleanup-killed run `claude_auth_required` from tool output or assistant text, and still detects a not-logged-in result, a revoked/expired token, a login prompt on stderr and the CLI's typed `authentication_failed` assistant event. Our patch's extra cases (typed `authentication_failed` event, singular `error` field, truncated first line at the capture cap) must be covered before retiring. |
| `DOWNSTREAM.md`, `AGENTS.md` | This document. | — | Keep. |

To rebuild the live source exactly: `git checkout 6f18750dcd` (or this branch without its documentation commits).

## Required behavioural checks

- Muse connection flow uses the intended subscription, isolates native credential storage, validates the resulting OAuth credential and never logs provider credentials. Existing saved connections remain usable. A browser approval link or connected status alone is not a successful model response.
- Muse provider defaults and migration replay work on existing data. UI metadata must remain browser-safe; do not pull Node-only server code into the browser bundle.
- Shared SSH tests demonstrate secret-marker absence from real SSH argv, command input fidelity, streaming and cancellation; ordinary Claude/Codex/Muse paths remain compatible.
- Hermes receives managed instructions and uses its selected isolated profile. A real bounded task authenticates with its temporary Paperclip run identity, performs task operations and completes. Permanent owner-board credentials must never substitute for that identity.
- Paperclip timeout/cancellation stops the underlying gateway-owned execution, not only its CLI/SSH client. Keep the Hermes and Paperclip halves of this interface compatible.
- Preserve company isolation, owner administration, approval boundaries and the existing private access path. Live model tests use only owner-authorised accounts/billing; acquiring credentials or new spend is not automatic update authority.

Useful focused surfaces include `packages/adapters/muse-local`, `packages/adapters/hermes`, `packages/adapter-utils/src/ssh*`, `server/src/services/local-ai-browser-login.test.ts`, `server/src/__tests__/local-ai-credentials.test.ts`, `server/src/__tests__/ai-connections.test.ts`, `server/src/__tests__/environment-execution-target.test.ts`, and the Muse connection UI tests.

## State is not source

Do not commit database dumps, encryption/signing keys, provider credentials, SSH identities, user profiles, execution logs or private deployment configuration. Back up those separately with restrictive permissions. Preserve the application database, encryption/signing configuration, connection state and external Hermes profile/managed-role files; a source backup alone cannot restore the service. Conversely, a database backup cannot restore a missing adapter implementation.

The host-specific activation, backup and health-check details belong in the operator's private `paperclip-native-ops` skill, not in this public source fork.
