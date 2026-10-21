# Checkout on DEV (ammari.my.id): turn it on with sandbox keys

For the owner, by hand. Goal: a real end-to-end purchase on dev with Midtrans **Sandbox**, a
Biteship **test** key and real Resend emails, so the 1 Dec prod launch (`checkout-prod.md`) holds
no surprises. Plan: `docs/plans/cart-checkout.md` (§12 variables, §13 manual checklist, §14
launch). General dev ops: `docs/deploy.md`.

No agent touched any server, dashboard or key for this. Every step below is yours.

## 0. Conventions (read once)

**Where each step runs**

| Tag | Meaning |
|---|---|
| **[Mac]** | Your Mac, in a terminal, at the repo root (`cd ~/Developer/ammari`), zsh or bash |
| **[dev VPS]** | A command sent to the dev server as `deploy` through the `devssh` helper below |
| **[Dashboard]** | A web dashboard (Midtrans, Biteship, Resend, Cloudflare) or the dev admin (`https://admin.ammari.my.id`) |

**[Mac] Define the helper once per terminal window** (works in zsh and bash; it only wraps ssh
with the dev deploy key, `docs/deploy.md` §1):

```bash
devssh() { ssh -i ~/ammari-secrets/ammari_deploy_key deploy@43.129.55.61 "$@"; }
```

**Secret rules (every step follows them)**

1. A secret goes from the dashboard into a file under `~/ammari-secrets/` (mode 600) with
   `pbpaste` (after the dashboard's own Copy button) or a hidden prompt (`read -s`). It is never
   typed into a command line, never `echo`ed, never `cat`ed to the terminal.
2. It reaches the server **on ssh's stdin**, into `/opt/ammari/set-env-var.sh` (this repo's
   `deploy/set-env-var.sh`, synced by every dev deploy). That script reads one line from stdin,
   writes `KEY=value` into the env file (mode 600) and prints only the key name and the length.
3. To verify, use `set-env-var.sh --check FILE KEY...` (set / empty / missing) and
   `--same FILE_A FILE_B KEY` (MATCH / MISMATCH). Never `grep` a secret's line.

**[Mac] Capturing a secret, the two ways** (used in parts B and D):

```bash
# a) Clipboard: press the dashboard's Copy button first, then
(umask 077 && pbpaste > ~/ammari-secrets/NAME) && pbcopy < /dev/null   # also clears the clipboard
wc -c < ~/ammari-secrets/NAME                                          # prints only a length

# b) Hidden prompt: run this, paste (nothing shows), press Enter
printf 'Paste, then Enter: '; IFS= read -rs v; printf '\n'; (umask 077 && printf '%s\n' "$v" > ~/ammari-secrets/NAME); unset v
wc -c < ~/ammari-secrets/NAME
```

Non-secret values (flags, URLs) go the same way through `printf '...\n' |`, so every env change
uses one tool. `pbcopy < /dev/null` clears the Mac clipboard, not a clipboard-history app or
Universal Clipboard: pause or clear those while handling keys. The dev key files stay in
`~/ammari-secrets/` for re-use (they are sandbox/test keys); delete them when the dev run is over.

## A. Ship session 17 to dev and check the server

**A1. [Mac] Commit and push this session to `dev`** (your normal flow), then watch **GitHub →
Actions → Deploy (dev)** go green. It syncs `deploy/` to `/opt/ammari`, including
`set-env-var.sh`.

Verify **[dev VPS]**:

```bash
devssh 'ls -l /opt/ammari/set-env-var.sh'
```

Expected: `-rwxr-xr-x ... /opt/ammari/set-env-var.sh`. If it is not executable, call it as
`bash ./set-env-var.sh` everywhere below.

**A2. [dev VPS] No `NODE_ENV` or `E2E_TEST_LOGIN` in any env file.** `E2E_TEST_LOGIN=true` unlocks
the fake payment and shipping providers and the `/api/test/*` routes; a `NODE_ENV` line overrides
the image's production build.

```bash
devssh 'cd /opt/ammari && ls env/*.env && grep -l -E "^[[:blank:]]*(export[[:blank:]]+)?(NODE_ENV|E2E_TEST_LOGIN)=" env/*.env; rc=$?; if [ $rc -eq 1 ]; then echo clean; elif [ $rc -ne 0 ]; then echo "CHECK FAILED (grep exit $rc)"; fi'
```

Expected: the env file names, then `clean`. A file name after the list means that file has a
forbidden line; `CHECK FAILED` means the check itself could not run (fix that first). Delete the
lines on the server (prints nothing), then re-run the check:

```bash
devssh 'cd /opt/ammari && for f in env/*.env; do sed -i -E "/^[[:blank:]]*(export[[:blank:]]+)?(NODE_ENV|E2E_TEST_LOGIN)=/d" "$f"; done'
```

**A3. [dev VPS] `DEPLOY_ENV` in web and admin.** These two flags are not secrets, so printing them
is fine:

```bash
devssh 'cd /opt/ammari && grep -H "^DEPLOY_ENV=" env/web.env env/admin.env'
```

Expected: `env/web.env:DEPLOY_ENV=dev` and `env/admin.env:DEPLOY_ENV=dev`. admin.env usually
has no line yet: the admin image is a production build, so without `DEPLOY_ENV=dev` it refuses
the sandbox settings and staff cannot cancel unpaid web orders. Add it (and fix web's if it says
anything other than `dev`):

```bash
printf 'dev\n' | devssh 'cd /opt/ammari && ./set-env-var.sh env/admin.env DEPLOY_ENV'
printf 'dev\n' | devssh 'cd /opt/ammari && ./set-env-var.sh env/web.env DEPLOY_ENV'
```

Only `production`, `dev`, `development` or `test` are accepted; anything else (a typo) makes the
payment and shipping code fail closed.

**A4. [Mac] The origin only accepts Cloudflare.** The cart, checkout and every per-IP limit trust
`CF-Connecting-IP`; with the flag on, production refuses cart writes without it.

```bash
curl -Ik https://ammari.my.id --resolve ammari.my.id:443:43.129.55.61 --max-time 10
```

Expected: a TLS error (`certificate required` / `alert 116`, curl exit 35 or 56), never an HTTP
status line. An HTTP answer means the origin can be reached without Cloudflare: stop and fix it
(`docs/deploy.md` §6) before going on.

How it is set up today: Caddy demands Cloudflare's origin-pull client certificate (Authenticated
Origin Pulls) and also refuses non-Cloudflare source IPs (`deploy/cloudflare/cloudflare-only.caddy`).
Prod uses **zone-level** AOP with its own CA, so only the `ammari.id` zone can reach the prod
origin. Dev uses **Global** AOP, whose certificate is shared by every Cloudflare customer: someone
with their own Cloudflare zone could in principle route to the dev origin. Their requests still
carry a `CF-Connecting-IP` that Cloudflare sets itself, and dev
holds no real money.
Honest limit: such traffic carries whatever source address its sender uses, so on dev the per-IP
limits (cart, OTP requests, checkout submits) can be bypassed by someone who sets that up; the
per-email OTP limits and the daily Biteship budgets still hold. Acceptable for a sandbox run on a
noindex dev site; the proposed hardening (zone-level AOP on dev too, Appendix 1) closes it and is
worth doing before dev is shared more widely.

**A5. [Dashboard: Cloudflare, `ammari.my.id` zone] Things that could block Midtrans or the cart.**

1. **Cloudflare Access.** Open `https://ammari.my.id` in a private window. If a Cloudflare Access
   login appears, Midtrans' server cannot reach the notification route either. In **Zero Trust →
   Access → Applications → Add an application → Self-hosted**, create one for domain
   `ammari.my.id`, path `api/payments/midtrans/notification`, with one policy, action **Bypass**,
   include **Everyone**. Exactly that one path; nothing else gets a bypass. If no Access login
   appears, there is nothing to do.
2. **Bot Fight Mode** (Security → Bots). On the Free plan it cannot be skipped for one path. If
   it is on, leave it on for now and check Security → Events after the first sandbox payment
   (step G1): any challenged or blocked request to `/api/payments/midtrans/notification` means
   turning Bot Fight Mode off for this zone. On Pro or higher (Super Bot Fight Mode), add a WAF
   custom rule instead: Security → WAF → Custom rules → Create, expression
   `(http.request.uri.path eq "/api/payments/midtrans/notification" and http.request.method eq "POST")`,
   action **Skip**, skipping all remaining custom rules, rate limiting rules, managed rules,
   Super Bot Fight Mode and Browser Integrity Check.
3. **No HTML caching.** After A6 the storefront must not be cached by Cloudflare (the cart icon and
   CTA are per flag state):

   ```bash
   curl -sI https://ammari.my.id/ | grep -i '^cf-cache-status'
   ```

   Expected: `cf-cache-status: DYNAMIC` (or no such line). `HIT` means a Cache Rule caches HTML:
   remove it. (Skip this check if Access blocks curl; the same header shows in the browser's
   network tab.)
4. **Logs and the "Lihat pesanan" token.** Order emails link `/orders/<no>?t=<token>`; the first
   request carries the token, which the app at once moves into a cookie (303 to a clean URL,
   `Referrer-Policy: no-referrer`). Caddy keeps no access log. Check that Cloudflare keeps no full
   URLs either: **Analytics & Logs → Logpush** has no job (Logpush is an Enterprise feature; on
   Free/Pro there is nothing to configure), and no WAF or rate-limiting rule matches `/orders/*`
   (Security → Events show the full URI, query included, for requests a rule acted on). Nothing to
   change if both hold.

**A6. Unsent "cancelled" emails before session 15.** Dev already runs session 15 and later, so
this check is moot here (plan session 15 note; see `checkout-prod.md` 1.6 for prod).

## B. Accounts and keys (sandbox / test)

**B1. [Dashboard: Midtrans Sandbox, `https://dashboard.sandbox.midtrans.com`]** Log in (create
the Sandbox account if needed). **Settings → Access Keys**: copy the **Server Key** (the Client
Key is not used: Snap runs in redirect mode).

**[Mac]** capture it (section 0, way a or b) as `~/ammari-secrets/dev-midtrans-server-key`, then
check that it works on the **Sandbox** without printing it. The prefix says nothing: newer Sandbox
accounts issue `Mid-server-...` keys, the same shape as production. Instead, ask the Sandbox status
API about an order id that cannot exist: a valid Sandbox key gets `404` (no such transaction), a
production key or a mistyped key gets `401`. As in B4, the key goes into a header file (curl reads
it with `-H @file`), never onto a command line:

```bash
( H="$HOME/ammari-secrets/.midtrans-header"; trap 'rm -f "$H"' EXIT INT TERM; umask 077
  printf 'authorization: Basic %s\n' "$(printf '%s:' "$(cat ~/ammari-secrets/dev-midtrans-server-key)" | base64)" > "$H"
  code="$(curl -sS --max-time 15 -H @"$H" -H 'accept: application/json' \
    "https://api.sandbox.midtrans.com/v2/KEYCHECK-$(date +%s)/status" \
    | grep -oE '"status_code" *: *"[0-9]+"' | head -n 1 | tr -dc '0-9')"
  case "$code" in
    404) echo sandbox-key-ok ;;
    401) echo "WRONG-KEY: the Sandbox answered 401 (a production key, or a mistyped key)" ;;
    *) echo "UNEXPECTED: status_code '${code:-none}' (network? retry once)" ;;
  esac )
```

Expected: `sandbox-key-ok`. (`printf` is a builtin and `base64` reads the key on stdin, so the key
never appears in `ps`; only the answer's `status_code` is printed. Midtrans' auth is HTTP Basic
with the server key as user and an empty password, hence the trailing `:`.) On `WRONG-KEY`, copy
the key again from **dashboard.sandbox.midtrans.com** (not the production dashboard). The app
cannot tell the two kinds apart by shape either: on dev it runs with `MIDTRANS_IS_PRODUCTION=false`
(Sandbox hosts), and a wrong key shows up in the web logs as `rejected MIDTRANS_SERVER_KEY (401)`
with `keyRejected: true` while checkout refuses to create a payment page.

**B2. [Dashboard: Midtrans Sandbox] Settings** (menu names as of Oct 2026; Midtrans moves them
sometimes):

1. **Settings → Payment → Notification URL:**
   `https://ammari.my.id/api/payments/midtrans/notification`. The app also sends this URL with
   every transaction (`X-Override-Notification`, from `MIDTRANS_NOTIFICATION_URL` in D1), so dev
   and local can share this Sandbox account; the dashboard value covers Midtrans' own test button.
2. **Settings → Snap Preference → System Settings → Finish redirect URL:**
   `https://ammari.my.id/checkout/finish`. Every transaction overrides it with its own
   `?order=...` URL; this is the fallback.
3. **Payment methods:** enable exactly QRIS, GoPay, ShopeePay, BCA VA, BNI VA, BRI VA, Mandiri
   Bill and Permata VA; **credit card off**. The app sends exactly these eight
   (`enabled_payments`) on every transaction, so Snap never offers anything else, but card must
   stay off in the dashboard too (owner decision 2).

Verify: the Snap page in G1 lists only those methods.

**B3. [Dashboard: Biteship, `https://dashboard.biteship.com`]** A Starter account (Rp0, pay per
request) is right for dev.

1. Turn **Testing Mode** on (sidebar toggle).
2. **Settings → API**: create a key; it must be labelled Development and start with
   `biteship_test.`. **[Mac]** capture it as `~/ammari-secrets/dev-biteship-key`, then:

   ```bash
   grep -q '^biteship_test\.' ~/ammari-secrets/dev-biteship-key && echo test-key-ok || echo NOT-A-TEST-KEY
   ```

3. Top up a small balance (e.g. Rp50.000): test-mode Maps and Rates are real data and billed per
   request on Starter. An empty balance answers 402, which checkout shows as "Ongkir belum bisa
   dihitung".
4. Activate couriers in the courier settings. Starter allows 3 active couriers; pick three from
   the allowlist (JNE, J&T, SiCepat are a good spread). Only active couriers answer rate requests.
   Prod (Grow) activates all six (`checkout-prod.md` 2.5).

**B4. [Mac] Ammari's origin area id** (`BITESHIP_ORIGIN_AREA_ID`): one Maps search for the shop's
own kecamatan or kode pos. The key goes into a header file (curl reads it with `-H @file`), never
onto a command line. Replace `<kode pos toko>`:

```bash
( H="$HOME/ammari-secrets/.biteship-header"; trap 'rm -f "$H"' EXIT INT TERM; umask 077
  printf 'authorization: %s\n' "$(cat ~/ammari-secrets/dev-biteship-key)" > "$H"
  curl -sS -H @"$H" 'https://api.biteship.com/v1/maps/areas?countries=ID&input=<kode pos toko>&type=single' \
    | tr '{' '\n' | grep -oE '"(id|name)":"[^"]+"' )
```

(`printf` is a shell builtin, so the key never appears in `ps`; the header file is removed when the
subshell ends, Ctrl-C included.) Pick the `id` whose `name`
matches the shop's kecamatan and kode pos (e.g. `IDNP...IDZ12345`) and save it (not a secret, but
kept with the others):

```bash
printf '%s\n' '<the id>' > ~/ammari-secrets/biteship-origin-area-id
```

Area ids are the same for test and live keys, so prod reuses this value.

**B5. [Mac] Optional but recommended: the two opt-in contract tests** (plan §13; they need the
local Postgres up, `docker compose up -d db`). The keys go in as environment variables of the
command (not arguments; only your own user and root can read a process's environment).

```bash
BITESHIP_CONTRACT_TEST=1 \
  BITESHIP_API_KEY="$(cat ~/ammari-secrets/dev-biteship-key)" \
  BITESHIP_ORIGIN_AREA_ID="$(cat ~/ammari-secrets/biteship-origin-area-id)" \
  pnpm --filter @ammari/commerce exec vitest run src/shipping/biteship.contract.test.ts

MIDTRANS_CONTRACT_TEST=1 MIDTRANS_SERVER_KEY="$(cat ~/ammari-secrets/dev-midtrans-server-key)" \
  pnpm --filter @ammari/commerce exec vitest run src/payments/midtrans.contract.test.ts
```

Expected: both pass. The Biteship one prints `[contract] services returned` and
`allowlist entries with no match`: compare the printed `courier_code`/`courier_service_code`
pairs with the allowlist (`jne/reg`, `jnt/ez`, `sicepat/reg`, `idexpress/reg`, `anteraja/reg`,
`pos/kilat_khusus`). On Starter only your three active couriers answer, so "no match" for the
other three is expected; a different code for an active one (e.g. JNE answering `reg19`) means the
allowlist in `packages/commerce/src/shipping/rules.ts` must change before launch (a code change,
tell the next session).

## C. Email (Resend)

**C1. [Dashboard: Resend] Click tracking off.** Domains → the domain dev's `EMAIL_FROM` uses →
Configuration: **Click tracking off** (and Open tracking off). Click tracking rewrites every link
through Resend's redirector, including the one-time "Masuk ke akun" login link and the "Lihat
pesanan" token link. Verified in G1: the links in the order emails point straight at
`https://ammari.my.id/...`.

**C2. [dev VPS] Email settings present:**

```bash
devssh 'cd /opt/ammari && ./set-env-var.sh --check env/web.env RESEND_API_KEY EMAIL_FROM BETTER_AUTH_URL CUSTOMER_BETTER_AUTH_SECRET ADMIN_SITE_URL'
```

Expected: all `set`. `ADMIN_SITE_URL` (optional, the owner email's "Buka di admin" link) can be
added with `printf 'https://admin.ammari.my.id\n' | devssh 'cd /opt/ammari && ./set-env-var.sh env/web.env ADMIN_SITE_URL'`.
Dev's Resend key sends **real** emails: in part G use only your own addresses.

## D. Checkout settings on the dev server

All commands are **[Mac]** sending to **[dev VPS]**.

**D1. Midtrans, web and admin** (the same sandbox key in both; admin uses it only to close an
unpaid order's payment page when staff cancel it):

```bash
devssh 'cd /opt/ammari && ./set-env-var.sh env/web.env MIDTRANS_SERVER_KEY' < ~/ammari-secrets/dev-midtrans-server-key
devssh 'cd /opt/ammari && ./set-env-var.sh env/admin.env MIDTRANS_SERVER_KEY' < ~/ammari-secrets/dev-midtrans-server-key
printf 'false\n' | devssh 'cd /opt/ammari && ./set-env-var.sh env/web.env MIDTRANS_IS_PRODUCTION'
printf 'false\n' | devssh 'cd /opt/ammari && ./set-env-var.sh env/admin.env MIDTRANS_IS_PRODUCTION'
printf 'DEV-\n' | devssh 'cd /opt/ammari && ./set-env-var.sh env/web.env MIDTRANS_ORDER_ID_PREFIX'
printf 'https://ammari.my.id/api/payments/midtrans/notification\n' | devssh 'cd /opt/ammari && ./set-env-var.sh env/web.env MIDTRANS_NOTIFICATION_URL'
```

Each prints e.g. `set-env-var: MIDTRANS_SERVER_KEY added in env/web.env (45 characters)`.
`CHECKOUT_PAYMENT_EXPIRY_MINUTES` / `CHECKOUT_STOCK_HOLD_MINUTES` stay unset (60 / 75 minutes).
Never set `PAYMENT_PROVIDER` or `SHIPPING_RATE_PROVIDER` on a server.

**D2. Biteship (web only):**

```bash
devssh 'cd /opt/ammari && ./set-env-var.sh env/web.env BITESHIP_API_KEY' < ~/ammari-secrets/dev-biteship-key
printf 'https://api.biteship.com\n' | devssh 'cd /opt/ammari && ./set-env-var.sh env/web.env BITESHIP_BASE_URL'
devssh 'cd /opt/ammari && ./set-env-var.sh env/web.env BITESHIP_ORIGIN_AREA_ID' < ~/ammari-secrets/biteship-origin-area-id
```

The daily budgets keep their defaults (1.500 Maps, 300 Rates per Jakarta day), plenty for dev.

**D3. The internal cron secret, the same value in web.env and cron.env** (sweep, emails,
retention; `docs/deploy.md` "Internal cron service"):

```bash
(umask 077 && openssl rand -hex 32 > ~/ammari-secrets/dev-cron-secret)
devssh 'cd /opt/ammari && ./set-env-var.sh env/web.env INTERNAL_CRON_SECRET' < ~/ammari-secrets/dev-cron-secret
devssh 'cd /opt/ammari && ./set-env-var.sh env/cron.env INTERNAL_CRON_SECRET' < ~/ammari-secrets/dev-cron-secret
devssh 'cd /opt/ammari && ./set-env-var.sh --same env/web.env env/cron.env INTERNAL_CRON_SECRET'
```

Expected last line: `INTERNAL_CRON_SECRET: MATCH`.

**D4. Check everything at once:**

```bash
devssh 'cd /opt/ammari && ./set-env-var.sh --check env/web.env MIDTRANS_SERVER_KEY MIDTRANS_IS_PRODUCTION MIDTRANS_ORDER_ID_PREFIX MIDTRANS_NOTIFICATION_URL BITESHIP_API_KEY BITESHIP_BASE_URL BITESHIP_ORIGIN_AREA_ID INTERNAL_CRON_SECRET DEPLOY_ENV STOREFRONT_CART_ENABLED PAYMENT_PROVIDER SHIPPING_RATE_PROVIDER E2E_TEST_LOGIN NODE_ENV'
devssh 'cd /opt/ammari && ./set-env-var.sh --check env/admin.env MIDTRANS_SERVER_KEY MIDTRANS_IS_PRODUCTION DEPLOY_ENV E2E_TEST_LOGIN NODE_ENV'
```

Expected: every key `set`, except `PAYMENT_PROVIDER`, `SHIPPING_RATE_PROVIDER`, `E2E_TEST_LOGIN`
and `NODE_ENV`, which must say `missing`.

**D5. Restart so the containers read the new env** (env files are read only at start; dev has one
`web` service, so the internal `web:3000` name survives a recreate):

```bash
devssh 'cd /opt/ammari && docker compose up -d --force-recreate admin web && docker compose up -d --no-deps --force-recreate cron && docker compose ps'
```

Expected: `admin`, `web`, `caddy`, `cron` all `Up` (admin/web `healthy` after ~30 s).

**D6. The cron service, about 6 minutes after D5:**

```bash
devssh 'cd /opt/ammari && docker compose logs --tail 20 cron'
```

Expected lines: `/api/internal/retention -> 200 {...}`, `/api/internal/payments/sweep -> 200
{...}`, `/api/internal/emails/dispatch -> 200 {...}`. `ERROR ... 401` = the two secrets differ
(D3); `503` = web lacks the secret, or the payment provider or email is not configured (D7 names
it); `no answer` = web is down. Full table: `docs/deploy.md` "Internal cron service".

**D7. Configuration problems in the logs** (after D6, so the sweep and the email pass have used
the payment and email configuration; names only, never values):

```bash
devssh 'cd /opt/ammari && logs="$(docker compose logs --since 30m web admin 2>&1)" || { echo "LOGS UNREADABLE"; exit 1; }; printf "%s\n" "$logs" | grep -iE "not configured|problems|missing" || echo no-config-warnings'
```

Expected: `no-config-warnings`. `LOGS UNREADABLE` means the check did not run. A line naming
variables (e.g. `MIDTRANS_IS_PRODUCTION must be true or false`) tells you which one to fix (back to
D1 to D3, then D5). Admin logs its payment problem only on a staff cancel, and shipping problems
appear only with the first area search, so re-run this after G1's first search and after G7.

## E. Store data in the dev admin

**E1. [Dashboard: dev admin] Konten → Pengaturan → Email:** the address that receives the owner's
"Pesanan baru dibayar" emails (`store_settings.support_email`). **Simpan.** Without it, owner
emails wait (a warning in web's logs) and are sent once it is set.

**E2. [Dashboard: dev admin] Produk:** no active product may show the badge **"Berat kirim belum
diisi"**. Open each one that does, fill **Berat kirim (gram)** (one packed piece, folded in its
plastic), Simpan. Checkout refuses an order containing a product without a weight.

**E3. [Dashboard: dev admin] Stok:** at least two test products with a few pieces in stock, and
one with exactly 1 piece (for the last-piece check in G6).

## F. Turn the cart on (dev)

**F1. [Mac → dev VPS] Flag on, web restarted:**

```bash
printf 'true\n' | devssh 'cd /opt/ammari && ./set-env-var.sh env/web.env STOREFRONT_CART_ENABLED' \
  && devssh 'cd /opt/ammari && grep -x STOREFRONT_CART_ENABLED=true env/web.env && docker compose up -d --force-recreate web && docker compose up -d --no-deps --force-recreate cron' \
  && echo FLAG-ON-DONE || echo "STOPPED: see the step that failed above"
```

Expected: `STOREFRONT_CART_ENABLED=true`, the containers recreated, `FLAG-ON-DONE`.

**F2. [Dashboard: dev admin] Full storefront revalidation:** Konten → Pengaturan → **Simpan**
(no change needed). The save revalidates the root layout (every page, including the ISR-cached
product pages) and the homepage data. Expected: a success toast, no "Coba lagi" link. A "Coba
lagi" link means admin could not reach web; press it after `docker compose ps` shows web healthy.

**F3. Verify [browser, private window]:** a product page shows **"Tambah ke keranjang"** with
WhatsApp as the outlined secondary button; the header shows the bag icon; `/cart` opens.

## G. End-to-end sandbox run (plan §13 "Manual sandbox checklist")

Use your own email addresses and a real phone number of yours. For each payment: Midtrans'
Sandbox simulators are at `https://simulator.sandbox.midtrans.com` (QRIS, GoPay, ShopeePay, VA,
Mandiri Bill). After each step, the matching checks:

- **Midtrans [Dashboard: Sandbox]:** Transactions shows the order id `DEV-ORD-...-1` with the
  right status; Settings → Payment → notification history shows HTTP **200** from
  `https://ammari.my.id/api/payments/midtrans/notification` (a 403 there means the server key in
  web.env is not this account's; a Cloudflare challenge page means A5.2).
- **Admin [Dashboard: dev admin] Pesanan:** the order, its payment badge and the Pembayaran
  section.
- **Email:** the buyer and owner emails in your inboxes within 5 minutes.

**G1. Guest order, QRIS, Java address.** Logged out: add a product, `/cart`, "Lanjut ke
checkout". Fill contact, recipient, search the kecamatan (3+ characters), pick it, full address;
section 3 shows the service ("JNE Reguler" or similar) and the subsidy line; Ringkasan shows
Ongkir (often "Rp0" in Java) and the total; tick the consent; **Bayar sekarang**. On the Snap page:
only the 8 methods, no card; a 60-minute countdown (not QRIS' own 15 minutes; if it says 15,
tell the next session). Pay with QRIS in the simulator.

Expected: finish page "Pembayaran berhasil"; admin shows the order paid and **Siap Kirim**
(`to_ship`) with Pengiriman (service, weight, ongkir); stock dropped by one; emails: "Pesanan
ORD-... menunggu pembayaran" then "Pembayaran pesanan ORD-... sudah kami terima" to the buyer
(both with "Lihat pesanan" and "Masuk ke akun"), "Pesanan baru dibayar: ORD-..." to the E1
address. The checkout submit working at all also confirms Next's server-action Origin check
works behind Cloudflare and Caddy (plan session 9 note).

**G2. The email links.** On another browser or phone (logged out): "Lihat pesanan" opens the order
(the address bar loses the `?t=` at once); "Masuk ke akun" opens a confirm page ("Masuk sebagai
a***@..."), **Masuk** lands on "Pesanan saya" (`/orders`) with the order. Opening the login link a
second time: "Link sudah tidak berlaku". Hover the links in the email: they must point at
`https://ammari.my.id/...`, not a tracking domain (C1).

**G3. BCA VA, outside Java** (a Sumatra or Sulawesi kecamatan, so the buyer pays part of the
ongkir): pay through the VA simulator with the VA number shown in Snap. Expected as G1, Ongkir
above Rp0, "subsidi Ammari -Rp20.000" on the checkout page and in the emails.

**G4. GoPay, ShopeePay, Mandiri Bill, BNI/BRI/Permata VA:** one order each if you have time;
at least GoPay and Mandiri Bill. Expected as G1.

**G5. Expiry.** Place an order and leave it unpaid. After 60 minutes the order page says
"Menunggu konfirmasi pembayaran"; within about 80 minutes (the 75-minute stock hold plus the
5-minute sweep) the order is **Dibatalkan**, stock is back, and "Pesanan ORD-... dibatalkan"
arrives with **Pesan lagi**, which refills the cart.

**G6. Logged in, with a voucher, last piece.** Log in (email OTP) with an account that has an
active voucher (dev admin, or a claimed card); in checkout pick the voucher (the summary shows
"Voucher -Rp20.000"); buy the product that has exactly 1 piece; pay. Expected: voucher used,
product shows sold out. In a second private window, a guest who had that product in the cart now
sees "Habis".

**G7. Staff actions [Dashboard: dev admin].**
1. An unpaid order (place one, do not pay): **Batalkan pesanan** → cancelled, voucher (if any)
   back, the Snap page for it now says expired; the cancelled email follows within 5 minutes.
2. A paid order: **Batalkan dan kembalikan dana** → "Perlu dicek" shows `refund_due`; then
   **Catat dana dikembalikan** with a short note → the flag clears; the buyer gets the "dana akan
   kami kembalikan" email.
3. A paid order: **/packing** shows it with the quoted service and "Tanpa kartu"; **Tandai
   dikirim** with a made-up resi → "Pesanan ORD-... sudah dikirim" within 5 minutes (cron email
   pass), and the order page's "Lacak pengiriman" shows courier and resi.

**G8. Shipping spot check** (plan §14): quotes for three kecamatan, one in Java, one in Sumatra or
Sulawesi, one in Papua. Compare each checkout figure ("Ongkir RpX" in section 3) with Biteship's
own rate check in its dashboard for the same origin, destination and weight (the weight is in the
admin order's Pengiriman section after placing it, or the product's weight + 100 g). They should
match for the chosen service. Also one kecamatan where no allowlisted courier serves: section 3
shows the WhatsApp message and "Bayar sekarang" refuses.

**G9. The packaging allowance** (plan §4.5.3): weigh one packed order (folded gamis in plastic,
inside the outer mailer). The code adds 100 g per order (`SHIPPING_PACKAGING_GRAMS`); if your
mailer weighs clearly more, tell the next session (a code constant).

**G10. Logs, once, after the run:**

```bash
devssh 'cd /opt/ammari && docker compose logs --since 3h web | grep -E "ERROR|budget_exhausted|unavailable|amount_mismatch|payment_anomaly" | tail -n 30 || true'
devssh 'cd /opt/ammari && docker compose logs --since 3h cron | grep -E "ERROR|ALERT" | tail -n 20 || true'
```

Expected: nothing unexplained. Any line about a provider being unavailable names a reason
(`402` = Biteship balance, `401/403` = key).

## H. Turning it off again (dev rollback)

```bash
printf 'false\n' | devssh 'cd /opt/ammari && ./set-env-var.sh env/web.env STOREFRONT_CART_ENABLED' \
  && devssh 'cd /opt/ammari && grep -x STOREFRONT_CART_ENABLED=false env/web.env && docker compose up -d --force-recreate web && docker compose up -d --no-deps --force-recreate cron' \
  && echo FLAG-OFF-DONE || echo "STOPPED: the flag may still be ON, see the step that failed above"
```

You must see `STOREFRONT_CART_ENABLED=false` and `FLAG-OFF-DONE`. Then **[dev admin] Konten →
Pengaturan → Simpan** (revalidation), and check in a private window. Expected: PDP shows "Tanya via
WhatsApp" again, `/cart` and `/checkout` are 404. Payment notifications, the sweep, the emails and
`/orders/*` keep working with the flag off (plan §14), so open orders still finish cleanly. Keys can
stay in place.

## Appendix 1. Proposed: zone-level Authenticated Origin Pulls on dev

Same procedure as prod (`deploy-prod/cloudflare/README.md` §2), with dev's names. It makes the dev
origin accept only the `ammari.my.id` zone's own certificate instead of any Cloudflare customer's.
There is a short outage (seconds to a minute) between steps 3 and 5.

1. **[Mac]** In `~/ammari-secrets/`, generate a dev CA and a leaf exactly as that README §2 steps
   1 and 2 show, with `-subj "/CN=Ammari Dev AOP CA"` and `-subj "/CN=ammari-dev-origin-pull"` and
   file names `ammari-dev-aop-ca.{key,pem}`, `dev-client.{key,pem}`.
2. **[Mac]** Copy only the CA certificate to the server, where Caddy reads it:
   `scp -i ~/ammari-secrets/ammari_deploy_key ~/ammari-secrets/ammari-dev-aop-ca.pem deploy@43.129.55.61:/opt/ammari/cloudflare/origin-pull-ca.pem.new`
3. **[Dashboard: Cloudflare, `ammari.my.id`]** SSL/TLS → Origin Server → Authenticated Origin
   Pulls → **Zone-level**: upload `dev-client.pem` and `dev-client.key`, enable the zone-level
   toggle.
4. **[dev VPS]** Swap the CA and recreate Caddy:
   `devssh 'cd /opt/ammari && mv cloudflare/origin-pull-ca.pem cloudflare/origin-pull-ca.pem.global && mv cloudflare/origin-pull-ca.pem.new cloudflare/origin-pull-ca.pem && chmod 600 cloudflare/origin-pull-ca.pem && docker compose up -d --force-recreate caddy'`
5. **Verify:** the site loads through Cloudflare, and A4's direct `curl --resolve` still fails
   with a TLS error. To undo: turn the zone-level toggle off, move `origin-pull-ca.pem.global`
   back, recreate caddy. Update `deploy/cloudflare/README.md` afterwards (it still says dev uses
   Global).
