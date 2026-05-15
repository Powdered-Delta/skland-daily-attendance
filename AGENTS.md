# AGENTS.md

## Cursor Cloud specific instructions

### Overview

This is a Nitro-based TypeScript service for automated Skland (森空岛) daily attendance. See `README.md` for full documentation.

### Prerequisites

- **Node.js 24** (matches Dockerfile and CI)
- **pnpm 10.32.1** (via corepack; specified in `package.json` `packageManager` field)

### Common commands

| Task | Command |
|------|---------|
| Install deps | `pnpm install --frozen-lockfile` |
| Lint | `pnpm lint` |
| Lint + fix | `pnpm lint:fix` |
| Build | `pnpm build` |
| Dev server | `pnpm dev` |
| Preview (prod) | `pnpm build && pnpm preview` |

### Known issues

- **Dev mode cron crash**: `pnpm dev` crashes on startup due to a cron pattern compatibility issue. The `scheduledTasks` in `nitro.config.ts` uses `0/2` syntax which the croner library bundled in Nitro beta rejects ("stepping with numeric prefix is not allowed"). The production build (`pnpm preview`) logs the error but still serves HTTP on port 3000. To fully fix, the cron expression `30 0/2 * * *` should be changed to `30 */2 * * *`.
- **Ignored build scripts**: pnpm 10 skips postinstall scripts for `esbuild`, `sharp`, and `workerd` by default. These are not needed for build/lint but may be needed for Wrangler (Cloudflare Workers) deployment.
- **Pre-existing lint error**: `pnpm lint` reports one YAML error in `.github/workflows/schedule.yml` (plain-scalar style). This is pre-existing.

### No automated tests

This project has no test suite. Validation is done via lint and build.

### Environment variables

No secrets are required for local development. The app defaults to local filesystem KV storage (`.data/kv`). `SKLAND_TOKENS` is only needed for actual attendance API calls.
