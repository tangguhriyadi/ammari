# Ammari

Software for Ammari, a syar'i gamis (modest Muslim dress) brand in Bandung, Indonesia. Run by a
husband (former software engineer, technical) and his wife (non-technical, handles day-to-day
operations — Orders, Packing, Stock, Production).

Full spec, schema, business rules, and open decisions: **[docs/SPEC.md](docs/SPEC.md)**. If
something here and SPEC.md disagree, SPEC.md wins — fix this file.

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
- **Visual identity:**
  - Primary: gray red `#695A5A`, white `#FFFFFF`, black `#000000`.
  - Status colors are muted earth tones: olive green (on track), brick red (below target). Do
    not use saturated red/green.

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
7. **One feature per session.** Keep changes small and commit often.

## Commands

To be filled in once the monorepo is scaffolded.

```bash
# install
# (placeholder — e.g. pnpm install)

# dev
# (placeholder — e.g. pnpm dev, or per-app: pnpm --filter web dev / pnpm --filter admin dev)

# build
# (placeholder — e.g. pnpm build, or per-app via Turborepo)

# test
# (placeholder)

# migrate
# (placeholder — e.g. pnpm --filter @ammari/db drizzle-kit generate / push)
```
