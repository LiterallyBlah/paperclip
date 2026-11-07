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
4. Renumber the Muse provider migration to the next free number on the new
   tag. Delete the cherry-picked migration file/snapshot, keep the schema
   checks, and run `pnpm db:generate` so journal and snapshot match. Update
   the migration path asserted in
   `server/src/__tests__/ai-connections.test.ts`.
5. Regenerate or hand-extend `packages/shared/src/app-definitions.generated.ts`
   so `muse.json` is imported, and bump the `APP_STORE_DEFINITIONS` length in
   `packages/shared/src/app-definitions.test.ts` by one.
6. Run the touched-package tests and typecheck, then open a fork PR whose
   diff is only the Muse patch. Never open anything against upstream.

## Retirement

Drop this patch when the upstream Muse adapter
(https://github.com/paperclipai/paperclip/pull/17845) ships in a release and
passes the same checks: subscription OAuth login with isolated native
credential storage, verified completed credentials, browser approval
rendering, and a real bounded agent run. A matching provider name alone is
not equivalence.

## Notes

- Do not commit database dumps, credentials, or deployment configuration.
- Deployment to the private host is a separate, owner-run step.
- Live databases that already applied the old `0334_muse_subscription_provider`
  migration need the journal reconciled before applying `0375`; the SQL only
  widens two provider check constraints and is safe to replay.
