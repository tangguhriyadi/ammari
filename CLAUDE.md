# Ammari

Software for Ammari, a syar'i gamis (modest Muslim dress) brand in Bandung, Indonesia. Run by a
husband (former software engineer, technical) and his wife (non-technical, handles day-to-day
operations — Orders, Packing, Stock, Production).

Full spec, schema, business rules, and open decisions: **[docs/SPEC.md](docs/SPEC.md)**. If
something here and SPEC.md disagree, SPEC.md wins — fix this file.

Before changing Next.js or Turborepo code/config, follow AGENTS.md (root) and apps/*/AGENTS.md:
read the docs bundled with the installed version, not memory.

@AGENTS.md

## Monorepo layout

pnpm workspaces + Turborepo:

- `apps/web` — the **"main site"** ("halaman utama"). Public storefront: catalog, product
  detail, voucher claim, account, and (from Dec 2026) cart/checkout. When anyone says "main
  site," they mean this app.
- `apps/admin` — the admin dashboard the wife uses daily.
- `packages/db` — Drizzle schema + migrations, shared by both apps.

## Conventions

- **Money:** `bigint` in whole rupiah (Drizzle `bigint` mode `"number"`). Never use floats for
  money.
- **Percentages:** integer basis points (e.g. `1800` = 18%). Never store a percentage as a
  float.
- **Time:** `timestamptz` columns, stored in UTC. Display, and compute daily/deadline boundaries
  (claim deadlines, voucher expiry, "today"), in `Asia/Jakarta`.
- **Language:** code, identifiers, and commit messages in English. All user-facing UI text in
  Indonesian.
- **URL paths:** all route paths are English (kebab-case); all UI text is Indonesian. Old
  Indonesian admin paths 308-redirect to their English replacements — see the `redirects()`
  table in `apps/admin/next.config.ts`.
- **Visual identity:**
  - Primary: gray red `#695A5A`, white `#FFFFFF`, black `#000000`.
  - Status colors are muted earth tones: olive green (on track), brick red (below target). Do
    not use saturated red/green.

## Pinned tooling versions (apps/web, apps/admin)

Both apps pin exact versions (no `^`/`~`) for two dev-tooling packages that trail the "latest"
npm dist-tag, because their actual runtime/peer support lags behind:

- **TypeScript `6.0.3`** — TypeScript 7 is a ground-up native (Go-based) rewrite;
  `typescript-eslint` (pulled in by `eslint-config-next`) currently declares a peer range of
  `>=4.8.4 <6.1.0` and does not support it yet. `6.0.3` is the newest release inside that range.
  Do not bump past `6.0.x` until `typescript-eslint` publishes TypeScript 7 support.
- **ESLint `9.39.5`** — `eslint-plugin-react` (pulled in by `eslint-config-next`) declares a
  peer range of `^3 || ... || ^9.7` and throws at lint time under ESLint 10
  (`contextOrFilename.getFilename is not a function` — it still calls the removed legacy
  `context.getFilename()` API). `9.39.5` is ESLint's `maintenance`-tagged latest 9.x release.
  Do not bump to ESLint 10 until `eslint-plugin-react` ships support for it.

## Database rules

- Always run `drizzle-kit generate` and **read the generated migration file** before committing
  it — do not assume it's correct.
- `drizzle-kit push` only against a **local** database. Never push against dev or prod.
- Prod migrations run only through the deploy pipeline (see Architecture in SPEC.md §2.3),
  never manually.
- Any operation that can happen concurrently — voucher claim, voucher redemption, order import —
  **must be atomic**: unique constraints + a transaction + conditional
  `UPDATE ... WHERE ... RETURNING`. Never implement these as check-then-write (a `SELECT` to
  check a condition followed by a separate `INSERT`/`UPDATE`); that pattern race-conditions under
  concurrent requests.

## Security

- Card tokens (`thank_you_cards.token_hash`) and OTP codes (`otp_codes`) are stored **only** as
  hashes, never in plaintext.
- OTP: expires after 5 minutes, max 5 attempts, rate-limited per destination (phone/email) and
  per IP.
- Payment webhooks must verify signatures and be idempotent. A "paid" status must never be set
  from a browser redirect — only from a verified server-to-server webhook or an authenticated
  status poll.
- Customer sessions (main site) can never reach admin endpoints — enforce this at the
  middleware/route level, not just in the UI.
- Secrets live only in environment variables, never committed to the repo.
- Admin access is dynamic RBAC (roles/permissions in the database, one role per staff user) —
  checked on the **server** for every page, server action, and route handler, never only by
  hiding UI. See [docs/SPEC.md §9](docs/SPEC.md#9-admin-access-control-rbac).

## Local environment safety

- Never run `docker compose down -v`, drop a database, `TRUNCATE`, or otherwise wipe local data
  (including the owner's seeded dev data in the `ammari` database) without asking the owner
  first, in that session — even for a throwaway investigation or a "clean slate" test run. This
  happened once already (an agent session wiped the local Postgres volume mid-task to validate a
  migration, silently losing the owner's dev-seeded data until it was manually reseeded).
- Prefer a separate, disposable database for experiments (e.g. `createdb ammari_scratch`, or
  `ammari_e2e` for e2e runs — see `packages/db/test/e2e-db.ts` and `apps/admin/e2e/global-setup.ts`)
  over touching `ammari` itself. Reversible,
  narrowly-scoped actions (inserting/deleting specific test rows you can name, wrapping a check
  in `BEGIN; ... ROLLBACK;`) are fine without asking; anything that resets or deletes data beyond
  rows you yourself just created in that session is not.

## Git

- Branch model: `dev` auto-deploys to the dev environment; `main` auto-deploys to prod. All work
  happens on `dev` (small features may use short-lived branches merged into `dev`). A release is
  a merge from `dev` into `main`. `main` is protected on GitHub — no direct pushes.
- The human commits and pushes. The agent never commits, pushes, merges, or creates branches
  unless explicitly asked to do so in that prompt.

## Workflow

This repo has agents, skills, and commands preinstalled in `.claude/` — use them:

1. **Start every feature with `/plan`** and wait for explicit user confirmation before writing
   any code.
2. **TDD** (`tdd-workflow` skill) is required for: vouchers, OTP, payments, and stock. UI pages
   are covered by e2e tests instead, not unit-level TDD.
3. **Before each commit, run `/code-review`**, routing to the matching reviewer:
   - `typescript-reviewer` — all TypeScript changes
   - `react-reviewer` — `.tsx` changes
   - `database-reviewer` — schema, migrations, queries
   - `security-reviewer` — auth, OTP, claim flow, payment code
   - `silent-failure-hunter` — import (Shopee/TikTok export) and webhook code
4. Use `/build-fix` for build or type errors.
5. Run `/checkpoint` after a feature passes verification.
6. Run `/save-session` at the end of a session and `/resume-session` at the start of the next
   one.
7. **One feature per session.** Keep changes small so each can be committed separately.

## Commands

```bash
# install (from repo root)
pnpm install

# local Postgres (pgvector/pgvector, Postgres 16 — matches dev/prod; local dev & tests only)
cp .env.example .env         # once, then adjust if needed
docker compose up -d db
pnpm --filter @ammari/db db:check   # prints server version + citext/vector availability

# dev (both apps via Turborepo; web on :3000, admin on :3001)
pnpm dev
# or one app at a time:
pnpm --filter @ammari/web dev
pnpm --filter @ammari/admin dev

# build / lint / typecheck (all workspaces via Turborepo)
pnpm build
pnpm lint
pnpm typecheck

# migrations (packages/db) — always run generate, then READ the migration file
pnpm --filter @ammari/db db:generate
pnpm --filter @ammari/db db:migrate   # local only; dev/prod run through the deploy pipeline
pnpm --filter @ammari/db db:studio

# test
# (placeholder — no test runner wired up yet; added alongside the tdd-workflow skill)
```
