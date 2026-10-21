# Checkout on PROD (ammari.id): deploy, prepare, launch on 1 Dec 2026

For the owner, by hand, in three parts:

1. **Deploy the checkout release with the flag off** (migrations 0030 to 0033; prod is at 0029
   today). Any time after the dev run in `checkout-dev.md` passed.
2. **Pre-launch setup** (target ~15 Nov): production keys, cron secret, Midtrans production,
   Biteship Grow, store settings, legal pages. Still flag off.
3. **Launch day, 1 Dec:** flag on, revalidate, smoke test, monitoring, rollback.

Background: `docs/plans/cart-checkout.md` (§12 variables, §14 launch), `docs/deploy-prod.md`
(routine deploys, env changes, backups). No agent touched the VPS, GitHub, Cloudflare or any
dashboard or key; every step is yours.

## 0. Conventions (read once)

| Tag | Meaning |
|---|---|
| **[Mac]** | Your Mac, a terminal at the repo root (`cd ~/Developer/ammari`), zsh or bash |
| **[prod VPS]** | A command sent to the prod server as `deploy` through `prodssh` below |
| **[GitHub]** | github.com → the repo → Actions |
| **[Dashboard]** | Midtrans, Biteship, Resend, Cloudflare, or the prod admin (`https://admin.ammari.id`) |

**[Mac] Helpers, once per terminal window** (zsh and bash):

```bash
prodssh() { ssh -i ~/ammari-secrets/ammari_prod_deploy_key deploy@43.173.52.121 "$@"; }
# Read-only SQL on prod: the query arrives on stdin, psql runs inside the db container with the
# container's own user and database (no password on any command line), and every transaction is
# read-only (PGOPTIONS), so a mistyped query cannot write.
prodsql() { prodssh 'cd /opt/ammari-prod && docker compose exec -T db sh -c "PGOPTIONS=\"-c default_transaction_read_only=on\" psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -At -v ON_ERROR_STOP=1"'; }
```

Use `prodsql` with a heredoc; it prints one line per query (a write fails with `cannot execute ...
in a read-only transaction`):

```bash
prodsql <<'SQL'
select 1;
SQL
```

**Secret rules.** Prod env files are edited **on your Mac** (`~/ammari-secrets/prod-*.env`, the
source of truth) and pushed with `deploy-prod/upload-prod-env.sh`, never edited on the VPS
(`docs/deploy-prod.md` §3). A secret goes from a dashboard into a file under `~/ammari-secrets/`
with `pbpaste` (after the dashboard's Copy button) or a hidden prompt, then into the env file with
`deploy/set-env-var.sh FILE KEY < file` (or `deploy/set-env-var.sh FILE KEY` alone for a hidden
prompt). Never typed into a command line, never `echo`ed or `cat`ed to the terminal. Verify with
`deploy/set-env-var.sh --check FILE KEY...` and `--same FILE_A FILE_B KEY`, which never show a
value.

```bash
# Capture from the clipboard (press the dashboard's Copy button first):
(umask 077 && pbpaste > ~/ammari-secrets/NAME) && pbcopy < /dev/null && wc -c < ~/ammari-secrets/NAME
```

`pbcopy < /dev/null` clears the Mac clipboard, not a clipboard-history app or Universal Clipboard on
your other devices: pause or clear those while handling keys. Loose key files are deleted once the
value is in the env files (the steps say when); the env files themselves are the source of truth.

**After any prod env change:** `deploy-prod/upload-prod-env.sh`, then on the VPS
`./recreate-active-slot.sh admin` and/or `./recreate-active-slot.sh web`. Never a bare
`docker compose up -d --force-recreate web-<slot>`: it drops the internal `web` alias that cron and
admin's revalidation use (`docs/deploy-prod.md` §3.2).

---

## Part 1. Deploy the checkout release, flag off

What changes: migrations **0030 to 0033** (checkout schema; shipping quote and product weight;
`shipping_areas` column rename on an empty table; login links). All additive and backward
compatible with the release live now; nothing the live release reads is dropped or renamed (0032
renames a column only the new code knows, on an empty table). Plus the new code, the `cron`
service (idles until its secret is set) and Caddy's `/api/internal/*` block. With the flag off and
no Midtrans/Biteship keys, the storefront looks exactly as today: `/cart` and `/checkout` 404,
WhatsApp stays the PDP's main button, payment notifications answer 503, quotes are unavailable.

**1.1 Preconditions (all must hold):**

1. `checkout-dev.md` parts A to G passed on dev **with the exact commit** you will deploy.
2. On that commit: `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, the admin e2e and
   the web e2e (flag off and on) are green.
3. Admin on prod has a staff account that can open Pesanan and Konten (to verify and revalidate).

**1.2 [Mac → prod VPS] Write down the release live now** (your rollback target):

```bash
prodssh 'cd /opt/ammari-prod && cat deployed-sha-admin deployed-sha-web && tail -n 3 deploy-history.log'
```

Note the web SHA as **ROLLBACK_SHA**. Both lines are normally the same SHA.

**1.3 [Mac] Pre-deploy health:**

```bash
deploy-prod/go-live-check.sh
```

Expected: no `FAIL` (`SKIP: env/cron.env does not exist yet` is expected before this deploy; the
checkout lines are `INFO`). Fix any `FAIL` first.

**1.4 [Mac] `DEPLOY_ENV=production` in admin.env** (harmless now; needed later for staff cancels):

```bash
First make sure the Mac copies are what the server runs, because `upload-prod-env.sh` overwrites
the server's files with them (only `same` / `DIFFERS` is printed, never content):

```bash
for f in admin web db backup; do
  l="$(shasum -a 256 < ~/ammari-secrets/prod-$f.env | cut -c1-64)"
  r="$(prodssh "sha256sum < /opt/ammari-prod/env/$f.env" | cut -c1-64)"
  if [ -n "$l" ] && [ "$l" = "$r" ]; then echo "$f.env: same"; else echo "$f.env: DIFFERS"; fi
done
```

Expected: four `same`. A `DIFFERS` means the server copy was edited directly (or the Mac copy was
changed and never uploaded): compare the key **names** with `cut -d= -f1 ~/ammari-secrets/prod-web.env`
and `prodssh 'cut -d= -f1 /opt/ammari-prod/env/web.env'`, bring the Mac copy up to date, and only
then continue.

```bash
printf 'production\n' | deploy/set-env-var.sh ~/ammari-secrets/prod-admin.env DEPLOY_ENV
grep -H -E '^(DEPLOY_ENV|STOREFRONT_CART_ENABLED)=' ~/ammari-secrets/prod-admin.env ~/ammari-secrets/prod-web.env
deploy/set-env-var.sh --check ~/ammari-secrets/prod-web.env E2E_TEST_LOGIN NODE_ENV PAYMENT_PROVIDER SHIPPING_RATE_PROVIDER
deploy/set-env-var.sh --check ~/ammari-secrets/prod-admin.env E2E_TEST_LOGIN NODE_ENV PAYMENT_PROVIDER
deploy-prod/upload-prod-env.sh
```

Expected: `prod-admin.env:DEPLOY_ENV=production`, `prod-web.env:DEPLOY_ENV=production`,
`prod-web.env:STOREFRONT_CART_ENABLED=false` (these flags are not secrets), and `missing` for every
key in the two `--check` lines. No recreate needed: the deploy starts fresh slots that read the
uploaded files.

**1.5 [Mac → prod VPS] Fresh backup** (`docs/deploy-prod.md` §5.3):

```bash
prodssh 'cd /opt/ammari-prod/backup && ./pg-backup.sh && cat last-backup-status.json'
```

Expected: the script ends without an error and the JSON's `timestamp` is from the last minutes.
Note its `daily_key`.

**1.6 [Mac] Restore drill with the migrations applied** (Docker Desktop running; never touches the
real `ammari` database or prod):

```bash
git fetch origin && git status --short          # must print nothing (clean tree)
git checkout <the SHA you will deploy> && pnpm install --frozen-lockfile
deploy-prod/restore-drill-local.sh --migrate --object <daily_key from 1.5>
git checkout dev && pnpm install --frozen-lockfile
```

Required output: `Migrations applied successfully.` then `==> Restore drill complete`. Anything
else: do not deploy; the migrator's own error is printed above it.

About the "unsent cancelled email" check (plan session 15 note): `order_notifications` does not
exist on prod before 0030, so no such row can exist; 1.9 confirms it after the deploy.

**1.7 [Mac] Fast-forward `main`** (`docs/deploy-prod.md` §1.1):

```bash
git fetch origin
git checkout dev && git pull --ff-only origin dev
git checkout main && git merge --ff-only dev && git push origin main
git checkout dev
```

**1.8 [GitHub] Deploy.** Actions → **Deploy (prod)** → Run workflow: branch `main`, `sha` empty
(or the exact SHA), **`skip_migrate` unchecked**. Expected: green; the job summary says
migrations ran and shows both slots.

**1.9 Verify.**

[Mac] External and SSH checks:

```bash
deploy-prod/go-live-check.sh
curl -s -o /dev/null -w '%{http_code}\n' https://ammari.id/cart       # 404
curl -s -o /dev/null -w '%{http_code}\n' https://ammari.id/checkout   # 404
```

Expected: no `FAIL` (now including `PASS: internal alias http://web:3000 answers` and the
`cron.env` forbidden-key check); both curls `404`.

[Mac → prod VPS] Migrations, empty checkout tables, no unsent cancelled emails:

```bash
prodsql <<'SQL'
select max(created_at) from drizzle.__drizzle_migrations;
select count(*) from orders where payment_status is not null;
select count(*) from order_notifications where kind = 'cancelled' and sent_at is null;
select to_regclass('public.customer_login_links') is not null;
SQL
```

Expected, line by line (after the `SET` line): `1792562966457` (the `when` of
`0033_customer_login_links` in `packages/db/drizzle/meta/_journal.json`, i.e. 0033 is the newest
applied migration), `0`, `0`, `t`.

[Mac → prod VPS] The cron service is idle, as intended until part 2:

```bash
prodssh 'cd /opt/ammari-prod && docker compose logs --tail 5 cron'
```

Expected: `INTERNAL_CRON_SECRET is not set in env/cron.env; idle (no sweep, no emails, no retention)`.

[Dashboard: prod admin, as the owner] Pesanan opens and has the **Perlu dicek** tab (empty);
Produk shows **"Berat kirim belum diisi"** on every published product without a weight (expected
until 2.8); a product page on `https://ammari.id` still shows **Tanya via WhatsApp**.

**1.10 Rollback of part 1** (only if 1.9 fails in a way a fix-forward cannot cover quickly):

1. [Mac → prod VPS] Confirm no checkout order exists (with the flag off none can, but check):

   ```bash
   prodsql <<'SQL'
      select count(*) from orders where payment_status is not null;
   SQL
   ```

   Must be `0`.
2. [GitHub] Deploy (prod) → Run workflow: branch `main`, `sha` = **ROLLBACK_SHA**,
   **`skip_migrate` checked**.
3. Expected: green; `deploy-prod/go-live-check.sh` has no `FAIL` except possibly the cron lines.
   The migrations stay (they are never reversed) and the old release ignores the new tables and
   columns. The `cron` container keeps running from the newer compose file and logs
   `ERROR ... 404` every 5 minutes against the old web (`docs/deploy-prod.md` §3.4: harmless);
   it idles anyway while `cron.env` is empty. `recreate-active-slot.sh` stays on the server too:
   a rollback syncs `deploy-prod/` from `main`'s HEAD, not from the old SHA.

---

## Part 2. Pre-launch setup (flag still off; target ~15 Nov)

Every step below is invisible to buyers: checkout stays 404 until part 3.

**2.1 [Dashboard: Midtrans production, `https://dashboard.midtrans.com`] Account approval.**
Complete the merchant onboarding (business documents) and ask for exactly these methods: QRIS,
GoPay, ShopeePay, BCA VA, BNI VA, BRI VA, Mandiri Bill, Permata VA. **No credit card**, not even
"for later" (owner decision 2). The reviewer looks at `https://ammari.id` and its Kebijakan
Privasi / Syarat & Ketentuan, so publish the legal pages (2.9) first. If the review asks for the
payment processor to be named on the privacy page, that is the one allowed exception to "never
name the gateway" (plan §11.1); `legal-drafts.md` has the optional sentence.

**2.2 [Dashboard: Midtrans production] Settings,** once approved:

1. Settings → Payment → **Notification URL:** `https://ammari.id/api/payments/midtrans/notification`
2. Settings → Snap Preference → System Settings → **Finish redirect URL:**
   `https://ammari.id/checkout/finish` (each transaction overrides it with its own `?order=`).
3. Payment methods: exactly the eight above enabled, card off.

**2.3 [Dashboard: Cloudflare, `ammari.id`] Nothing in front of the webhook.**

1. No Cloudflare Access on prod (there should be none; if there is, add the same one-path Bypass
   as `checkout-dev.md` A5.1).
2. **Bot Fight Mode** (Security → Bots), **Browser Integrity Check** and managed WAF rules: on
   the Free plan Bot Fight Mode cannot be skipped per path. During 2.11's test payment, watch
   Security → Events: any challenge or block on `/api/payments/midtrans/notification` means
   turning off whichever feature did it for this zone (the Event names it). On Pro or higher, add
   the Skip rule from `checkout-dev.md` A5.2 instead.
3. **No HTML cache:** `curl -sI https://ammari.id/ | grep -i '^cf-cache-status'` must say `DYNAMIC`
   (or print nothing). `HIT` means a Cache Rule caches HTML: remove it before launch.
4. **No full-URL logs:** Analytics & Logs → Logpush has no job, and no WAF / rate-limiting rule
   matches `/orders/*` (the first hop of a "Lihat pesanan" link carries `?t=<token>`; Security →
   Events would show it for any request a rule acted on).
5. **Origin is Cloudflare-only:** already part of `go-live-check.sh` (direct TLS to the VPS IP is
   refused). Prod uses zone-level Authenticated Origin Pulls with its own CA plus Cloudflare's IP
   list, so only the `ammari.id` zone reaches the origin. (`deploy-prod/cloudflare/README.md` §2
   said "toggle OFF" until session 17; the site could not be serving through Caddy's `client_auth`
   if that were still true, and the go-live check proves the boundary either way. Confirm the
   Zone-level toggle shows ON in the dashboard once.)

**2.4 [Mac] Midtrans production key into web and admin:**

```bash
# Midtrans production dashboard → Settings → Access Keys → Server Key → Copy, then:
(umask 077 && pbpaste > ~/ammari-secrets/prod-midtrans-server-key) && pbcopy < /dev/null
K=~/ammari-secrets/prod-midtrans-server-key
( H="$HOME/ammari-secrets/.midtrans-header"; trap 'rm -f "$H"' EXIT INT TERM; umask 077
  printf 'authorization: Basic %s\n' "$(printf '%s:' "$(cat "$K")" | base64)" > "$H"
  code="$(curl -sS --max-time 15 -H @"$H" -H 'accept: application/json' \
    "https://api.midtrans.com/v2/KEYCHECK-$(date +%s)/status" \
    | grep -oE '"status_code" *: *"[0-9]+"' | head -n 1 | tr -dc '0-9')"
  echo "Midtrans production API answered status_code ${code:-none}"
  [ "$code" = 404 ] ) \
  && deploy/set-env-var.sh ~/ammari-secrets/prod-web.env MIDTRANS_SERVER_KEY < "$K" \
  && deploy/set-env-var.sh ~/ammari-secrets/prod-admin.env MIDTRANS_SERVER_KEY < "$K" \
  && deploy/set-env-var.sh --same ~/ammari-secrets/prod-web.env ~/ammari-secrets/prod-admin.env MIDTRANS_SERVER_KEY \
  && rm "$K" && echo MIDTRANS-KEY-DONE \
  || echo "STOPPED: the key does not work on the production API, or a write failed; nothing after the failing step ran"
printf 'true\n' | deploy/set-env-var.sh ~/ammari-secrets/prod-web.env MIDTRANS_IS_PRODUCTION
printf 'true\n' | deploy/set-env-var.sh ~/ammari-secrets/prod-admin.env MIDTRANS_IS_PRODUCTION
printf 'https://ammari.id/api/payments/midtrans/notification\n' | deploy/set-env-var.sh ~/ammari-secrets/prod-web.env MIDTRANS_NOTIFICATION_URL
```

Expected: `Midtrans production API answered status_code 404`, `MIDTRANS_SERVER_KEY: MATCH`, then
`MIDTRANS-KEY-DONE`. The check asks the **production** status API about an order id that cannot
exist (the key travels in a header file that is removed afterwards, never on a command line or in
`ps`; only the answer's `status_code` is printed): `404` (no such transaction) means the key is
valid on production; `401` means a Sandbox key (newer Sandbox keys also start with `Mid-server-`,
so the prefix proves nothing) or a mistyped one: copy it again from **dashboard.midtrans.com**, not
the Sandbox dashboard, and rerun the block. Anything else (`none`, `5xx`): network or Midtrans
trouble, retry later; do not set the key by hand. The app itself only refuses an old-style `SB-`
key in production; a wrong-environment key would surface as `rejected MIDTRANS_SERVER_KEY (401)`
with `keyRejected: true` in the web logs while checkout refuses to create payment pages.
**`MIDTRANS_ORDER_ID_PREFIX` stays empty in prod** (plan D7). Never set `PAYMENT_PROVIDER` or `SHIPPING_RATE_PROVIDER`.

**2.5 [Dashboard: Biteship] Grow plan, couriers, live key.**

1. Subscribe to **Grow** (Rp149.000/month; the new plan structure applies from 2 Nov 2026).
   Confirm with Biteship the open items in plan §15 "What to confirm" (six couriers active at
   once, their service codes, billing).
2. Courier settings: activate the six allowlisted couriers: JNE (`reg`), J&T (`ez`), SiCepat
   (`reg`), ID Express (`reg`), AnterAja (`reg`), POS (`kilat_khusus`).
3. Turn **Testing Mode off**, Settings → API: create a production key (starts with
   `biteship_live.`).
4. Balance: Maps and Rates inside Grow's quota cost nothing extra; a top-up is needed only once
   Phase K books shipments.

**[Mac]**

```bash
(umask 077 && pbpaste > ~/ammari-secrets/prod-biteship-key) && pbcopy < /dev/null
grep -q '^biteship_live\.' ~/ammari-secrets/prod-biteship-key \
  && deploy/set-env-var.sh ~/ammari-secrets/prod-web.env BITESHIP_API_KEY < ~/ammari-secrets/prod-biteship-key \
  && echo BITESHIP-KEY-SET \
  || echo "STOPPED: not a live Biteship key (biteship_live.), or the write failed"
printf 'https://api.biteship.com\n' | deploy/set-env-var.sh ~/ammari-secrets/prod-web.env BITESHIP_BASE_URL
deploy/set-env-var.sh ~/ammari-secrets/prod-web.env BITESHIP_ORIGIN_AREA_ID < ~/ammari-secrets/biteship-origin-area-id
```

`biteship-origin-area-id` is the id found in `checkout-dev.md` B4 (the same for test and live). The
daily budgets keep their defaults: 1.500 Maps and 300 Rates per Jakarta day, under Grow's 50.000 /
31 = 1.612 and 10.000 / 31 = 322. Set `BITESHIP_DAILY_MAPS_BUDGET` / `BITESHIP_DAILY_RATES_BUDGET`
only to go lower.

Optional one-request check that the live key works (one Maps call, inside the quota; the header
file is removed even on Ctrl-C), then the loose key file goes:

```bash
( H="$HOME/ammari-secrets/.biteship-header"; trap 'rm -f "$H"' EXIT INT TERM; umask 077
  printf 'authorization: %s\n' "$(cat ~/ammari-secrets/prod-biteship-key)" > "$H"
  curl -sS -o /dev/null -w '%{http_code}\n' -H @"$H" 'https://api.biteship.com/v1/maps/areas?countries=ID&input=40132&type=single' )
rm ~/ammari-secrets/prod-biteship-key
```

Expected: `200` (this proves the key, not that it reached the server; 2.10 checks the server).

**2.6 [Mac] Internal cron secret, the same value in web and cron:**

```bash
(umask 077 && openssl rand -hex 32 > ~/ammari-secrets/.cron-secret)
deploy/set-env-var.sh ~/ammari-secrets/prod-web.env INTERNAL_CRON_SECRET < ~/ammari-secrets/.cron-secret
deploy/set-env-var.sh ~/ammari-secrets/prod-cron.env INTERNAL_CRON_SECRET < ~/ammari-secrets/.cron-secret
deploy/set-env-var.sh --same ~/ammari-secrets/prod-web.env ~/ammari-secrets/prod-cron.env INTERNAL_CRON_SECRET
rm ~/ammari-secrets/.cron-secret
```

Expected: `INTERNAL_CRON_SECRET: MATCH`. (`prod-cron.env` holds only this line; `upload-prod-env.sh`
uploads it when it exists.)

**2.7 [Mac] Email settings and the full check of the local files:**

```bash
printf 'https://admin.ammari.id\n' | deploy/set-env-var.sh ~/ammari-secrets/prod-web.env ADMIN_SITE_URL
deploy/set-env-var.sh --check ~/ammari-secrets/prod-web.env MIDTRANS_SERVER_KEY MIDTRANS_IS_PRODUCTION MIDTRANS_ORDER_ID_PREFIX MIDTRANS_NOTIFICATION_URL BITESHIP_API_KEY BITESHIP_BASE_URL BITESHIP_ORIGIN_AREA_ID INTERNAL_CRON_SECRET RESEND_API_KEY EMAIL_FROM CUSTOMER_BETTER_AUTH_SECRET DEPLOY_ENV STOREFRONT_CART_ENABLED PAYMENT_PROVIDER SHIPPING_RATE_PROVIDER E2E_TEST_LOGIN NODE_ENV
deploy/set-env-var.sh --check ~/ammari-secrets/prod-admin.env MIDTRANS_SERVER_KEY MIDTRANS_IS_PRODUCTION DEPLOY_ENV E2E_TEST_LOGIN NODE_ENV
```

Expected: everything `set`, except `MIDTRANS_ORDER_ID_PREFIX` (`empty` or `missing`, both fine),
`PAYMENT_PROVIDER`, `SHIPPING_RATE_PROVIDER`, `E2E_TEST_LOGIN`, `NODE_ENV` (`missing`).

**[Dashboard: Resend]** Domains → `mail.ammari.id` → Configuration: **Click tracking off** and Open
tracking off (click tracking would rewrite the one-time login link through Resend's redirector).

**Push and restart [Mac → prod VPS]:**

```bash
deploy-prod/upload-prod-env.sh
prodssh 'cd /opt/ammari-prod && ./recreate-active-slot.sh admin && ./recreate-active-slot.sh web'
```

Expected: both end with `==> done: ...`; the web run also prints `internal alias http://web:3000
answers` and recreates cron. A failed health check prints the slot's last log lines; most likely a
variable the app refuses (the log names it). Fix the file on the Mac, upload, run the script again.

**[Mac] Backup of the secrets directory** (it changed): `docs/deploy-prod.md` §4.1.

**2.8 [Dashboard: prod admin] Store data.**

1. Konten → Pengaturan → **Email**: the address for the owner's "Pesanan baru dibayar" emails.
   Simpan.
2. Produk: fill **Berat kirim (gram)** for every published product until no product shows
   "Berat kirim belum diisi" (Haura Dress at the time of writing).
3. Confirm the packaging allowance (100 g per order in code) by weighing one packed order, if not
   already done on dev (`checkout-dev.md` G9).

**2.9 [Dashboard: prod admin] Legal and info pages** (Konten → Halaman):

1. **Kebijakan Privasi** and **Syarat & Ketentuan**: replace with the texts in
   `docs/launch/legal-drafts.md` (after your own read and edits), **Terbitkan** each.
2. **Pengiriman** page and the **announcement bar** (Konten → Pengaturan → Teks pengumuman): the
   subsidy wording ("subsidi ongkir hingga Rp20.000", not "gratis ongkir").
3. **Cara Pemesanan**: leave as is until launch day (3.5), then describe the cart.

**2.10 [Mac] Readiness check, about 15 minutes after 2.7's restart** (so the cron log has three
rounds):

```bash
deploy-prod/go-live-check.sh --checkout=ready
```

Expected: no `FAIL`. It verifies, without printing any secret: the production Midtrans key in web
and admin (same value, not an old-style `SB-` key; the prefix cannot tell a newer Sandbox key, so 2.4's
API check is what proves the environment), `MIDTRANS_IS_PRODUCTION=true` in both, admin
`DEPLOY_ENV=production`, the notification URL, a live Biteship key and its base URL, no fake
provider and no order-id prefix, the cron secret matching in web.env and cron.env, the internal
`web` alias, and in the cron log at least one `sweep -> 200` and one `emails/dispatch -> 200` with
no `ERROR`/`ALERT` in the last 15 minutes. The cart flag must still be `false`.

**2.11 [Dashboard: Midtrans production] One real low-value payment, refunded** (plan §14). Checkout
is still 404, so use Midtrans' own **Payment Link** (if your dashboard has it): create a link for
e.g. Rp10.000, pay it with QRIS from your own e-wallet, then refund it from the dashboard
(Transactions → the transaction → Refund; QRIS supports it). Then check:

- Settings → Payment → notification history: the notifications reached
  `https://ammari.id/api/payments/midtrans/notification` with HTTP **200** (the app answers 200 to
  a transaction it does not know; that proves Cloudflare and Caddy let Midtrans through and the key
  matches; a 403 means the server key in prod-web.env is not this account's).
- Cloudflare Security → Events: no challenge on that path (2.3.2).

**2.12 Ready.** Write down for launch day: ROLLBACK flag steps (3.7), the product you will buy in
the smoke test, and the Midtrans refund steps.

---

## Part 3. Launch day, 1 Dec 2026

Pick a quiet hour (e.g. 07:00 WIB). Allow 45 minutes.

**3.1 [Mac] Last checks:**

```bash
deploy-prod/go-live-check.sh --checkout=ready
prodssh 'cd /opt/ammari-prod/backup && ./pg-backup.sh'
```

Expected: no `FAIL`; the backup ends cleanly.

**3.2 [Mac → prod VPS] Flag on:**

```bash
printf 'true\n' | deploy/set-env-var.sh ~/ammari-secrets/prod-web.env STOREFRONT_CART_ENABLED \
  && grep -x 'STOREFRONT_CART_ENABLED=true' ~/ammari-secrets/prod-web.env \
  && deploy-prod/upload-prod-env.sh \
  && prodssh 'cd /opt/ammari-prod && grep -x STOREFRONT_CART_ENABLED=true env/web.env && ./recreate-active-slot.sh web' \
  && echo FLAG-ON-DONE || echo "STOPPED: see the step that failed above"
```

Expected: `STOREFRONT_CART_ENABLED=true` printed twice (Mac, then server), `==> done: web-<slot>
recreated ...` with the alias line, then `FLAG-ON-DONE`. (A few seconds of downtime for
the storefront, not for admin.)

**3.3 [Dashboard: prod admin] Full storefront revalidation:** Konten → Pengaturan → **Simpan** (no
change). It revalidates the root layout (every page, including the ISR-cached product pages that
still hold the old CTA and no cart icon) and the homepage. Expected: success toast, no "Coba lagi"
link (a "Coba lagi" means admin could not reach web: check that 3.2 printed the alias line, run
`./recreate-active-slot.sh web` again if not, then press "Coba lagi").

**3.4 [Mac] Verify:**

```bash
deploy-prod/go-live-check.sh --checkout=live
```

Expected: no `FAIL`, including `product page /products/... shows 'Tambah ke keranjang'` and
`STOREFRONT_CART_ENABLED=true`. In a private browser window: the bag icon in the header, "Tambah
ke keranjang" on a product, WhatsApp as the outlined second button.

**3.5 Smoke test: one real order.**

1. In a private window, as a guest with your own email and WhatsApp number: add the cheapest
   product, check out to your own address, check section 3 (service, ongkir, subsidy line) and
   the total, **Bayar sekarang**. The Snap page lists only the 8 methods. Pay with QRIS.
2. Expected within a minute: finish page "Pembayaran berhasil"; admin Pesanan shows the order
   **Siap Kirim**, payment paid; stock down by one; emails "menunggu pembayaran" and "sudah kami
   terima" (with working "Lihat pesanan" and "Masuk ke akun" links pointing at
   `https://ammari.id/...`), and "Pesanan baru dibayar" to the store email.
3. Undo it: in admin **Batalkan dan kembalikan dana**; refund the QRIS payment from the Midtrans
   dashboard; then, if the order still shows `refund_due`, **Catat dana dikembalikan** with a note
   ("uji peluncuran, refund via dashboard"). Stock is back, the voucher (if any) too, and the
   buyer gets the cancel email.
   (Or keep the order and ship it to yourself as a full test of packing and "Tandai dikirim".)
4. Konten → Halaman → **Cara Pemesanan**: publish the cart wording. Announce the launch.

**3.6 Monitoring.**

First 2 hours, then daily for the first week:

```bash
deploy-prod/go-live-check.sh --checkout=live
prodssh 'cd /opt/ammari-prod && docker compose logs --since 24h cron | grep -E "ERROR|ALERT" | tail -n 20'
prodssh 'cd /opt/ammari-prod && docker compose logs --since 24h "web-$(cat active-slot-web)" | grep -E "budget_exhausted|unavailable|amount_mismatch|payment_anomaly|still unpaid and open|refused" | tail -n 30'
```

What to look for: cron `ALERT` lines (sweep or emails failing 3 times in a row); web
`budget_exhausted` (raise the daily Rates budget only within Grow's quota, plan session 10 note),
`unavailable` (Biteship down or key/balance problem: checkout refuses with "Ongkir belum bisa
dihitung", WhatsApp still works), `still unpaid and open long after its payment window` (open
that order in admin). Daily in admin: the **Perlu dicek** tab (stock short at payment, paid after
cancel, refunds due). Midtrans dashboard: notification history all 200. Biteship dashboard: API
usage against the Grow quota. UptimeRobot and the email alerts (`docs/deploy-prod.md` §6) keep
running as before.

**3.7 Rollback (cart off again).** Any time something on the checkout path misbehaves:

```bash
printf 'false\n' | deploy/set-env-var.sh ~/ammari-secrets/prod-web.env STOREFRONT_CART_ENABLED \
  && grep -x 'STOREFRONT_CART_ENABLED=false' ~/ammari-secrets/prod-web.env \
  && deploy-prod/upload-prod-env.sh \
  && prodssh 'cd /opt/ammari-prod && grep -x STOREFRONT_CART_ENABLED=false env/web.env && ./recreate-active-slot.sh web' \
  && echo FLAG-OFF-DONE || echo "STOPPED: the flag may still be ON, see the step that failed above"
```

You must see `FLAG-OFF-DONE`. Then **[prod admin] Konten → Pengaturan → Simpan** (revalidation),
and **always** run `deploy-prod/go-live-check.sh --checkout=ready`: it must show
`PASS: web.env: STOREFRONT_CART_ENABLED=false`, `/cart` and `/checkout` returning 404 and the PDP
back to "Tanya via WhatsApp". Leave the keys and the cron secret in place: payment notifications, the expiry sweep,
the order emails and `/orders/*` stay on with the flag off (plan §14, decision 40), so orders
already placed are paid, expired or cancelled cleanly, and their email links keep working. Put a
short note in the announcement bar if you like.

**Never roll the app image back to a release before the checkout release once a checkout order
exists** (check with `prodsql`: `select count(*) from orders where payment_status is not null;`).
The old code does not know payments, holds or the cancel rules for web orders. Fix forward instead
(revert or patch on `dev`, let dev deploy, fast-forward `main`, deploy), with the flag off in the
meantime.
