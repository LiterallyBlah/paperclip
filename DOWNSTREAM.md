# Maintained downstream: Muse patch only

This fork is stock Paperclip plus one patch: the Muse Code subscription
provider (`muse_local`). Everything else is configuration.

- Fork: https://github.com/LiterallyBlah/paperclip (`origin`)
- Upstream: https://github.com/paperclipai/paperclip (`upstream`)
- Branch: `muse-only`, cut from upstream tag `v2026.1106.0`
- Upstream equivalent (still open at cut time):
  https://github.com/paperclipai/paperclip/pull/17845

## Rebasing the Muse patch onto a new release

1. `git fetch upstream --tags` and pick the new release tag deliberately.
2. Create a fresh branch from that tag (for example `muse-only-<tag>`).
3. Cherry-pick the Muse commits from the previous `muse-only` branch, in
   order. Resolve conflicts as a union: upstream additions (such as the
   `github` provider) and `muse` both stay.
4. Handle the provider migration, in this order:
   a. Renumber the Muse provider migration to the next free number on the
      new tag. Delete the cherry-picked migration file/snapshot, keep the
      schema checks, run `pnpm db:generate`, and update the migration path
      asserted in `server/src/__tests__/ai-connections.test.ts`.
   b. Grep the new tag's migrations for
      `ai_connection_defaults_provider_check` and
      `ai_provider_defaults_provider_check`. Union `'muse'` into the last
      stock migration that re-adds those checks when its index is greater
      than the set the live database has already applied. A newer stock
      migration that re-adds the checks without `muse` runs before the
      renumbered Muse migration and fails on existing `muse` rows.
      This branch carries that union in `0361_mighty_dracula.sql`.
5. Regenerate `packages/shared/src/app-definitions.generated.ts` with the
   repo's catalog tooling (see `doc/connections/CONNECTOR-PLAYBOOK.md`) so
   `muse.json` is imported, and bump the `APP_STORE_DEFINITIONS` length in
   `packages/shared/src/app-definitions.test.ts` by one.
6. Run the touched-package tests and typecheck, then open a fork PR whose
   diff is only the Muse patch. Never open anything against upstream.

## Deploying onto a live database

No manual journal step is needed. Paperclip's migrator matches applied
migrations by file-content hash and ignores unknown hashes, so the old
`0334_muse_subscription_provider` row is harmless. Never run drizzle-kit's
own migrator against the live database; use normal server boot or the repo
migration entrypoint.

1. Back up the database. Migrations are forward-only.
2. Preflight, read-only:
   `SELECT provider, count(*) FROM ai_provider_defaults GROUP BY 1;`
   and the same for `ai_connection_defaults`;
   `SELECT count(*) FROM drizzle.__drizzle_migrations;`
3. Deploy and start. Watch the "Applying N pending migrations" log.
4. Verify both constraints list `github` and `muse`:
   `SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname LIKE 'ai_%_provider_check';`
   Then check `/api/health` and run one bounded Muse task.

## Retirement

Drop this patch when the upstream Muse adapter
(https://github.com/paperclipai/paperclip/pull/17845) ships in a release and
passes the same checks: subscription OAuth login with isolated native
credential storage, verified completed credentials, browser approval
rendering, and a real bounded agent run. A matching provider name alone is
not equivalence.

## Notes

- Do not commit database dumps, credentials, or deployment configuration.
- Only local login is supported. Muse is not admitted to sandbox device
  login.
- Deployment to the private host is a separate, owner-run step.
