# Courier booking and tracking on DEV (ammari.my.id): Biteship test mode, activation, go-live

For the owner, by hand. Phase K of `docs/plans/cart-checkout.md` (§15 Phase K, decisions 46 to 55):
staff book the courier from admin ("Pesan kurir"), print our own 120 x 100 mm label, and the
courier's webhook plus a 3-hourly poll move web orders to **Dikirim** and **Selesai** and fill the
buyer's "Lacak pengiriman" timeline. This runbook sets it up on dev with the Biteship **test** key,
produces the two test orders Biteship's Order API activation form asks for, checks the printed
label, and lists what changes for prod (the prod commands themselves are in
`checkout-prod.md` Part 4).

No agent touched any server, dashboard or key for this. Every step below is yours.

State when this was written (2026-10-22): K1 to K4 on `dev`, migrations up to **0035** (K4 adds
none). Already done on dev and verified: the test webhook is registered, "Pesan kurir" booked
**ORD-202610-0007** (waybill `WYB-1792634407489`), its label printed to PDF correctly, and test
webhooks moved it to Dikirim and then Selesai with both emails. Steps marked **(done on dev)** only
need repeating after a key or secret rotation.

## 0. Conventions

Same as `checkout-dev.md` §0: **[Mac]** (repo root), **[dev VPS]** through `devssh`,
**[Dashboard]**. Define the helper once per terminal window:

```bash
devssh() { ssh -i ~/ammari-secrets/ammari_deploy_key deploy@43.129.55.61 "$@"; }
```

Secrets live in files under `~/ammari-secrets/` (mode 600), reach the server on ssh's stdin into
`/opt/ammari/set-env-var.sh`, and are pasted into a dashboard only through the clipboard
(`pbcopy < file`, then `pbcopy < /dev/null` right after pasting). Never typed on a command line,
never `echo`ed or `cat`ed to the terminal. Pause clipboard-history apps and Universal Clipboard
while doing this.

The files this runbook uses:

| File | What |
|---|---|
| `dev-biteship-key` | the Biteship **test** key (`biteship_test.`), `checkout-dev.md` B4 |
| `biteship-origin-area-id` | Ammari's own Biteship area id, `checkout-dev.md` B4 (not secret) |
| `dev-biteship-webhook-path` | the webhook path token (secret) |
| `dev-biteship-webhook-secret` | the webhook header secret (secret) |

## A. Ship K4 to dev

**A1. [Mac]** Commit and push to `dev` (your normal flow), watch **GitHub → Actions → Deploy
(dev)** go green. No migration in K4.

**A2. [Dashboard: dev admin]** Open ORD-202610-0007 → **Pengiriman**: you now see **ID pesanan
Biteship** with a **Salin** button, **Riwayat pelacakan** (every courier step with its source:
Webhook, Cek berkala, Staf) and, at the top, the order's status. On the storefront
(`https://ammari.my.id/orders/ORD-202610-0007`, logged in as the buyer) "Lacak pengiriman" shows the
courier, the resi with **Salin**, and the timeline with the latest step on top.

## B. Env values on dev (done on dev)

All **[Mac]** sending to **[dev VPS]**.

**B1. admin.env: booking** (decisions 50 and 51). The sender name, phone and pickup address are not
secrets, but they never go in the repo: each `read` line asks for the value (type it, Enter), so no
placeholder can be saved by mistake. The app checks them again at start.

```bash
devssh 'cd /opt/ammari && ./set-env-var.sh env/admin.env BITESHIP_API_KEY' < ~/ammari-secrets/dev-biteship-key
printf 'https://api.biteship.com\n' | devssh 'cd /opt/ammari && ./set-env-var.sh env/admin.env BITESHIP_BASE_URL'
devssh 'cd /opt/ammari && ./set-env-var.sh env/admin.env BITESHIP_ORIGIN_AREA_ID' < ~/ammari-secrets/biteship-origin-area-id
printf 'Nama pengirim (e.g. Ammari): '; IFS= read -r v; [ -n "$v" ] && printf '%s\n' "$v" | devssh 'cd /opt/ammari && ./set-env-var.sh env/admin.env BITESHIP_SHIPPER_NAME' || echo "STOPPED: empty"
printf 'No. HP pengirim (08...): '; IFS= read -r v; [ -n "$v" ] && printf '%s\n' "$v" | devssh 'cd /opt/ammari && ./set-env-var.sh env/admin.env BITESHIP_SHIPPER_PHONE' || echo "STOPPED: empty"
printf 'Alamat penjemputan (jalan, nomor, RT/RW, kelurahan): '; IFS= read -r v; [ -n "$v" ] && printf '%s\n' "$v" | devssh 'cd /opt/ammari && ./set-env-var.sh env/admin.env BITESHIP_SHIPPER_ADDRESS' || echo "STOPPED: empty"; unset v
printf 'DEV-\n' | devssh 'cd /opt/ammari && ./set-env-var.sh env/admin.env BITESHIP_REFERENCE_PREFIX'
```

After B4's restart, check the sender in the first label you print (F4): it shows exactly what was
saved.

Rules the app checks at start (a wrong value refuses booking with a message and logs the variable
name): name 2 to 60 characters, phone an Indonesian mobile number, address 10 to 300 characters,
prefix `A-Z0-9-` at most 16 (required on dev: dev and local share one test account, so a local
booking must never collide with a dev one; local uses `LOCAL-`). A live key is refused on dev.

**B2. web.env: tracking and the webhook** (decision 54: web reads only; no sender, no prefix). The
web key is the same test key (set in `checkout-dev.md` D2). Create the two webhook secrets once
(skip if the files exist; they do since K3):

```bash
[ -s ~/ammari-secrets/dev-biteship-webhook-path ]   || (umask 077 && openssl rand -hex 32 > ~/ammari-secrets/dev-biteship-webhook-path)
[ -s ~/ammari-secrets/dev-biteship-webhook-secret ] || (umask 077 && openssl rand -hex 32 > ~/ammari-secrets/dev-biteship-webhook-secret)
devssh 'cd /opt/ammari && ./set-env-var.sh env/web.env BITESHIP_WEBHOOK_PATH_TOKEN' < ~/ammari-secrets/dev-biteship-webhook-path
devssh 'cd /opt/ammari && ./set-env-var.sh env/web.env BITESHIP_WEBHOOK_HEADER_SECRET' < ~/ammari-secrets/dev-biteship-webhook-secret
printf 'X-Ammari-Courier-Secret\n' | devssh 'cd /opt/ammari && ./set-env-var.sh env/web.env BITESHIP_WEBHOOK_HEADER_NAME'
```

The header name is not a secret (a plain name, never a standard or proxy header; the app refuses
those). The path token and the header secret must differ.

**B3. Daily read budget** (optional, decision 48): order reads by webhook, poll and staff share one
budget, default **60 a day**. Leave `BITESHIP_DAILY_ORDERS_BUDGET` unset in both files, or set the
same value in both.

**B4. Check, then restart:**

```bash
devssh 'cd /opt/ammari && ./set-env-var.sh --check env/admin.env BITESHIP_API_KEY BITESHIP_BASE_URL BITESHIP_ORIGIN_AREA_ID BITESHIP_SHIPPER_NAME BITESHIP_SHIPPER_PHONE BITESHIP_SHIPPER_ADDRESS BITESHIP_REFERENCE_PREFIX DEPLOY_ENV SHIPPING_ORDER_PROVIDER'
devssh 'cd /opt/ammari && ./set-env-var.sh --check env/web.env BITESHIP_API_KEY BITESHIP_WEBHOOK_PATH_TOKEN BITESHIP_WEBHOOK_HEADER_NAME BITESHIP_WEBHOOK_HEADER_SECRET INTERNAL_CRON_SECRET SHIPPING_ORDER_PROVIDER'
devssh 'cd /opt/ammari && ./set-env-var.sh --same env/web.env env/admin.env BITESHIP_API_KEY'
devssh 'cd /opt/ammari && docker compose up -d --force-recreate admin web && docker compose up -d --no-deps --force-recreate cron && docker compose ps'
```

Expected: every key `set` except `SHIPPING_ORDER_PROVIDER`, which must say `missing` in both (it is
the e2e fake switch; `set-env-var.sh` refuses to write it). `BITESHIP_API_KEY: MATCH`.

**B5. The poll runs** (the cron calls it at start and every 3 hours):

```bash
devssh 'cd /opt/ammari && docker compose logs --tail 40 cron | grep shipping/poll' || echo "NO MATCH: the poll has not run yet or cron is not logging; wait a minute after B4 and run it again"
```

Expected `/api/internal/shipping/poll -> 200 {...}`. `NO MATCH` twice in a row is a failure, not
"quiet": check `docker compose ps cron`. `503` = web lacks the key or base URL (the web
log names the variable), `429` = the day's read budget is used up (tomorrow it reads again), `502` =
Biteship did not answer.

**B6. [Dashboard: Cloudflare, `ammari.my.id`] Let Biteship through** (done on dev). If dev sits
behind Cloudflare Access (`checkout-dev.md` A5.1), add one more Access application exactly like the
Midtrans one: path `api/shipping/biteship/webhook`, policy **Bypass**, include **Everyone**. Nothing
else. Bot Fight Mode: same advice as A5.2, with the path `/api/shipping/biteship/webhook/` (a prefix:
`starts_with(http.request.uri.path, "/api/shipping/biteship/webhook/")`).

## C. Register the test webhook (done on dev)

Biteship webhooks carry no signature, are not retried, and test and live mode each have their own
webhook. Ours is a hint only: every post is answered 200, and only a post with the right path token
**and** the right header makes the app re-read the order from Biteship (at most once per shipment
every 2 minutes) and apply that answer.

1. **[Dashboard: Biteship]** Switch on **Testing Mode**. Open the webhook settings (Integrations /
   Webhook) → **Add webhook**.
2. **[Mac]** Put the URL on the clipboard (the token never shows on screen), paste it into the URL
   field, then clear the clipboard:
   ```bash
   { printf 'https://ammari.my.id/api/shipping/biteship/webhook/'; tr -d '\n' < ~/ammari-secrets/dev-biteship-webhook-path; } | pbcopy
   # paste into "Webhook URL", then:
   pbcopy < /dev/null
   ```
3. **Headers Signature Key:** type `X-Ammari-Courier-Secret`.
4. **Headers Signature Secret:**
   ```bash
   tr -d '\n' < ~/ammari-secrets/dev-biteship-webhook-secret | pbcopy
   # paste into "Headers Signature Secret", then:
   pbcopy < /dev/null
   ```
5. Events: tick **order.status**, **order.price** and **order.waybill_id**. Save. If the dashboard
   sends a test post on save, it gets 200 "ok".
6. **[Mac]** Each post leaves exactly one log line (never the token, the header value or the body):
   ```bash
   devssh 'cd /opt/ammari && docker compose logs --since 15m web 2>&1 | grep "courier webhook"' || echo "NO MATCH: no post reached web in 15 minutes"
   ```
   `NO MATCH` after a post means it never reached the app: check the URL, Cloudflare (B6) and the
   dashboard's Events Log.
   `auth: 'ok'` is right. `bad_path` = the URL's token differs from `BITESHIP_WEBHOOK_PATH_TOKEN`,
   `missing_header` / `bad_header` = the header key or secret differs, `not_configured` = web.env
   lacks one of the three (B2). A post for an order id we do not know logs `shipment: 'not ours'`
   (a test post, or another app on the same Biteship account) and reads nothing.

**Rotating the token or secret:** new values into web.env first (B2, restart web), then the
dashboard. Posts in between answer 200 but change nothing; the 3-hourly poll catches up.

## D. Test webhooks move an order (done on dev with ORD-202610-0007)

Test-mode orders are simulated: no courier comes, no balance is used.

1. Place a paid order on dev (`checkout-dev.md` G, Midtrans sandbox).
2. **[Dashboard: dev admin]** The order → **Pesan kurir**. Pengiriman shows "Kurir dipesan", the
   waybill, **ID pesanan Biteship** and the first history entry (source "Staf").
3. **[Dashboard: Biteship]** Shipments → the order → **Update Status**, one step at a time:
   allocated, picking_up, picked. Within a minute or two the admin order is **Dikirim** with the
   waybill as resi; the buyer gets "Pesanan ... sudah dikirim" (the cron email pass, up to 5
   minutes) and sees the timeline on `/orders/<no>`. Then dropping_off, delivered: **Selesai** and
   "Pesanan ... sudah sampai".
4. Each step shows in **Riwayat pelacakan** with source "Webhook". Several posts within 2 minutes
   are fine: they wait for the read window and one read serves them all.

## E. The two activation test orders

Biteship's Order API activation form asks for one **delivered** and one **cancelled** test order id
made by our integration.

**E1. Delivered: ORD-202610-0007** (done). Its Biteship order id: **[dev admin]** Pesanan → search
`ORD-202610-0007` → open → **Pengiriman** → **ID pesanan Biteship** → **Salin**. Paste it into a
note for G. (It is the id Biteship's dashboard shows for that shipment; not a secret.)

**E2. Cancelled, through our own "Batalkan pengiriman":**

1. Place another paid order on dev (`checkout-dev.md` G).
2. **[dev admin]** The order → **Pesan kurir** → wait for "Kurir dipesan".
3. **Batalkan pengiriman** → reason **Ganti kurir** (or any) → confirm. Pengiriman shows "Kurir
   belum dipesan." and below it "Percobaan 1: Dibatalkan ..." with its **ID pesanan Biteship** →
   **Salin** into the note.
4. **[Dashboard: Biteship]** Shipments: that order shows cancelled.
5. Tidy up: book it again and let it run (D3), or cancel the order itself in admin (sandbox money).

## F. Print the label on the thermal printer and scan it with a phone

Decision 49: our own 120 x 100 mm landscape label, Code 128 at a module width a 203 dpi printer can
draw exactly. The PDF page is **portrait 100 mm wide x 120 mm tall**, exactly like the QR sticker
PDF and the roll itself, with the label drawn turned 90 degrees inside it (the label's left edge
along the top of the page). So the driver has nothing to rotate: the first test print used a
landscape page, the driver turned and shifted it onto the roll, ~2-3 mm of the label's left edge
was cut off ("J&T" printed as "&T") and the print ran over the gap into the next sticker. All text,
lines and the barcode (quiet zones included) stay at least 3 mm inside every edge. Checked by
software (rasterized at 203 dpi, margins measured and the barcode decoded); this is the real-world
check.

1. **[dev admin]** A booked order (E2's rebooked one, or any) → **Cetak label** (or /packing →
   **Cetak label**). If a "Sebagian teks di label dipotong atau diganti" dialog appears, read it.
   The PDF downloads: one page per order. On screen the page is portrait with the text running
   down the page: that is correct, do not rotate it.
2. **Once per printer (and after changing the roll): gap calibration**, so the printer knows where
   each 100 x 120 mm sticker starts. Without it the print drifts and crosses the gap.
   - Load the roll, close the cover, printer on and idle (no blinking error light).
   - Press and hold the **FEED** button until the status light blinks (about 2-3 seconds on most
     203 dpi label printers of this type), then release. The printer feeds a few stickers while it
     measures the gap and stops at the start of the next sticker.
   - If it keeps feeding without stopping or stops mid-sticker, check that the roll sits against
     the guides and the gap sensor is not covered, then repeat. If the OKAY printer's manual
     describes a different button sequence (or its Windows/macOS utility has a "Calibrate" / "Auto
     detect" button), use that.
   - Driver settings for the printer (System Settings → Printers or the driver's own preferences),
     if it has them: media type **labels with gaps** (not continuous / not black mark), paper size
     **100 x 120 mm**.
3. Print from the PDF viewer on the computer connected to the thermal printer:
   - paper / label size **100 x 120 mm** (the same paper size the QR sticker sheets use), portrait;
   - scale **100% / Actual size**. Never "Fit to page", "Shrink oversized pages" or "Scale to
     fit": scaling breaks the barcode's dot grid and moves the margins;
   - turn off **Auto rotate** / "Auto portrait/landscape" if the dialog shows it (macOS Preview:
     untick "Auto Rotate"; Chrome: Layout **Portrait**, Scale **Default/100**, Margins **None**);
   - print density / darkness: the printer's normal setting; raise it one step only if the bars
     come out grey.
4. Look at it: the whole label lands on one sticker with a blank border of about 3-4 mm on every
   side (nothing cut, nothing over the gap; "J&T" and "PENERIMA" complete), the bars are solid black
   with clean white gaps, the blank space before and after the barcode is untouched, the waybill
   text under the barcode is readable, recipient and sender text readable, "NON COD" printed. If
   the print is shifted along the roll (towards or over the gap), run the gap calibration (2)
   again; if it is shifted or cut sideways, check the roll guides and that the paper size is
   100 x 120 mm and the scale 100%.
5. Scan with a phone: Google Lens (Android or iOS) or any barcode scanner app (Code 128), from about
   15 cm, flat and well lit. **Pass:** it reads within a couple of tries and the decoded text equals
   the waybill shown in admin **exactly** (same letters, digits and hyphens). If a courier app
   (J&T, JNE) has a resi scanner, try it too.
6. If it fails: print once more at 100% with density one step higher; if it still fails, note the
   printer model, the waybill and a photo of the label, and use Biteship's own label from its
   dashboard (A6) for real parcels until it is fixed.
7. Keep the PDF: you can upload it with the activation form (G).

## G. Fill the Order API activation form

**[Dashboard: Biteship]** The activation request (Biteship docs: "Submit activation request",
https://biteship.com/id/docs/go_live/submit-activation-request). Fill in:

- **Test order delivered:** the id from E1. **Test order cancelled:** the id from E2.
- **Couriers:** JNE, J&T, SiCepat, AnterAja, ID Express, POS. **Not J&T Cargo** (only the six
  regular services checkout quotes).
- **Integration handles:** tick **price change** (`order.price`: we store the new cost and flag
  "Ongkir kurir lebih mahal" above Rp5.000 over the quote) and **waybill change**
  (`order.waybill_id`: the order's resi follows the new waybill).
- **Insurance:** no. **COD:** no (buyers pay online; the label says NON COD).
- **Label:** optional; upload the PDF from F if the form offers it (we print our own label; Biteship
  has no label API).

Biteship reviews it; activation applies to the live key.

## H. Going live (summary; commands in `checkout-prod.md` Part 4)

1. **Grow plan** active (`checkout-prod.md` 2.5) and the Order API activation (G) approved.
2. **Live key in both prod env files:** the same `biteship_live.` key in `prod-web.env` (already,
   2.5) and `prod-admin.env`, with the base URL and origin area id. A test key is refused in
   production; a live key is refused anywhere else.
3. **Sender:** `BITESHIP_SHIPPER_NAME`, `BITESHIP_SHIPPER_PHONE`, `BITESHIP_SHIPPER_ADDRESS` in
   `prod-admin.env` (the real pickup address).
4. **`BITESHIP_REFERENCE_PREFIX` for prod:** leave it **empty** (references become
   `ORD-...-K1`). Production refuses `DEV-`, `LOCAL-`, `E2E-`, `CT-` and `TEST-`.
5. **Live webhook:** new path token and header secret for prod (never the dev ones), into
   `prod-web.env`, then registered with **Testing Mode off** at
   `https://ammari.id/api/shipping/biteship/webhook/<token>`, same header key, the three events.
6. **Balance top-up:** courier fees for real bookings come from the Biteship balance (QRIS or
   transfer). Keep enough for a few days of parcels; a booking with too little balance is refused
   with "Saldo Biteship tidak cukup" and staff use the manual path meanwhile.
7. **First real parcel:** book one real order, print its label (F), hand it to the courier, and
   watch it reach Dikirim and Selesai on its own.

## I. Day to day, and when something looks wrong

| You see | Meaning | Do |
|---|---|---|
| Pengiriman: "Pemesanan belum pasti" | the booking's answer was lost | **Cek ulang pemesanan**; never book again by hand first |
| "Pelacakan otomatis tertunda: batas harian ..." | the day's read budget (60) is used | nothing; it reads again tomorrow, or **Cek ulang pemesanan** for one order |
| Perlu dicek "Pelacakan berhenti" | no pickup 2 days after booking, or no courier news for 5 days | check with the courier or in the Biteship dashboard; Pengiriman shows the last news and last check |
| Perlu dicek "Masalah pengiriman" | the courier reported a problem, a return, a cancel we did not ask for, or a status we cannot read | Pengiriman shows the last courier status and the history; check before changing the order |
| Perlu dicek "Resi beda dengan pesanan kurir" | the resi typed at "Tandai dikirim" / "Ubah resi" is not the booked waybill | **Pakai resi pesanan kurir** if the parcel went with the booking; if it went another way, **Batalkan pengiriman** (before pickup) and **Tandai beres**. The buyer sees no courier timeline until the two match |
| Perlu dicek "Ongkir kurir lebih mahal" | Biteship charged more than Rp5.000 over the checkout quote (re-weighing) | check the weight; Ammari pays the difference, then **Tandai beres** |
| The courier never reports "delivered" | | once you know the buyer has it: **Tandai selesai** (it asks first). No "sudah sampai" email is sent, not even if the courier reports it later, and the 3-hourly check stops reading it |
| Biteship is down | booking and tracking fail | the manual path: book with the courier directly, **Dikirim** with courier and resi, later **Tandai selesai** |

The buyer's "Lacak pengiriman" never names Biteship, a cost or the driver. When the automatic read
fails or the courier has gone quiet it shows a short note ("Kabar pengiriman terbaru belum bisa kami
tampilkan..." / "Belum ada kabar baru dari kurir...").
