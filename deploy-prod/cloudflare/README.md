# Cloudflare origin TLS — prod, zone-level Authenticated Origin Pulls

Prod uses a genuinely different Cloudflare trust setup from dev
(`deploy/cloudflare/README.md`) — not just a different file with the same shape. Read that file
first for the three-toggle background (Global / Zone-level / Per-hostname); this one only covers
what's different for **Zone-level**, which is what prod actually uses
(`docs/plans/prod-deploy.md`, "Decisions already made").

Two unrelated certificate pairs are involved, easy to conflate:

| | What it is | Who presents it, to whom | Lives at |
|---|---|---|---|
| **Origin certificate** | Caddy's own TLS identity | Caddy → Cloudflare | `/opt/ammari-prod/caddy/certs/origin.{pem,key}` |
| **AOP leaf cert + key** | Proves a request really came from Cloudflare | Cloudflare → Caddy | leaf+key: **uploaded to Cloudflare only, not on the VPS**; the CA **root** that verifies it: `/opt/ammari-prod/cloudflare/origin-pull-ca.pem` |

The origin certificate (`caddy/certs/`) is unrelated to this document — see
`docs/deploy-prod.md` (Session 7) for that half, same shape as dev's.

## 1. Why zone-level, not Global (dev's choice)

Dev's Global AOP trusts Cloudflare's own shared client certificate — the same one for every
Cloudflare account, published at a fixed URL. That's fine for dev, but prod's decision
(`docs/plans/prod-deploy.md`, "Decisions already made") is a **custom per-zone certificate**: we
generate our own CA, issue a leaf signed by it, and upload that leaf (certificate **and** private
key) to Cloudflare's zone-level AOP slot for `ammari.id` specifically. Cloudflare then presents
*our* leaf — not its shared one — on every origin pull to this zone, and Caddy's `trust_pool`
verifies against *our* CA root, not Cloudflare's published Global CA. The two trust anchors are
not interchangeable: pointing prod's `trust_pool` at Cloudflare's Global CA (or leaving Zone-level
off while the Caddyfile expects it) breaks origin pulls outright.

## 2. The flow, as actually done (status: leaf+key uploaded, CA on origin, toggle OFF)

This was done directly against the real Cloudflare dashboard and the real VPS — not simulated —
per `docs/plans/prod-deploy.md` §4 step 5. Recorded here for the renewal procedure (§3 below) and
so this isn't tribal knowledge.

1. **Generate our own CA**, on the owner's own machine, never the VPS:
   ```bash
   openssl req -x509 -newkey rsa:2048 -days 3650 -nodes \
     -keyout ammari-prod-aop-ca.key -out ammari-prod-aop-ca.pem \
     -subj "/CN=Ammari Prod AOP CA"
   ```
   The CA's own key (`ammari-prod-aop-ca.key`) never leaves the owner's machine/password
   manager. Only the CA's **public certificate** (`ammari-prod-aop-ca.pem`) goes anywhere near
   the VPS.

2. **Issue a leaf certificate signed by that CA**, explicitly marked as NOT itself a CA
   (`basicConstraints=CA:FALSE` — a leaf must never be usable to sign further certs):
   ```bash
   openssl req -newkey rsa:2048 -nodes -keyout client.key -out client.csr \
     -subj "/CN=ammari-prod-origin-pull"
   openssl x509 -req -in client.csr -CA ammari-prod-aop-ca.pem -CAkey ammari-prod-aop-ca.key \
     -CAcreateserial -days 825 -out client.pem \
     -extfile <(printf "basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\n")
   ```
   825 days (not the CA's own 3650) — the longest leaf validity public CAs/browsers still widely
   tolerate, and it keeps this cert inside Cloudflare's own expiry-notification window (§3).
   **Done, as of 2026-10-17:** `CN=ammari-prod-origin-pull`, `CA:FALSE`, valid to **2036**.

3. **Upload the leaf — both halves — to Cloudflare's zone-level AOP slot.** Dashboard:
   `ammari.id` zone → **SSL/TLS → Origin Server → Authenticated Origin Pulls → Zone-level** (not
   Global, not Per-hostname) → upload **`client.pem` and `client.key` together**. Cloudflare
   needs the private key too: it's the one *presenting* this exact cert+key pair on every origin
   pull, not merely validating someone else's. **Done.**

4. **Put the CA root — only the root, never the leaf's key — on the VPS**, at
   `/opt/ammari-prod/cloudflare/origin-pull-ca.pem`. This is what
   `deploy-prod/Caddyfile`'s `client_auth { trust_pool file { pem_file ... } } }` reads. Caddy
   trusts the CA, not the specific leaf, so renewing the leaf later (§3) never requires touching
   the Caddyfile. **Done.**

5. **Turn the Zone-level toggle ON — deliberately held back until Caddy is actually serving with
   client_auth configured and this leaf's CA already in place.** Enabling the toggle before the
   Caddyfile (this session's own deliverable) exists would make the origin unreachable with
   nothing behind it to notice or roll back cleanly — the same 520-with-no-useful-Caddy-log
   failure mode dev's own README warns about for the opposite (Zone-level-on-with-nothing-
   uploaded) misconfiguration. **Still OFF as of this writing** — turn it on only after:
   - `deploy-prod/Caddyfile` (this session) is deployed and `caddy validate` passes against it
     on the real VPS, and
   - the CA root from step 4 is confirmed present and readable at
     `/opt/ammari-prod/cloudflare/origin-pull-ca.pem` on the VPS, and
   - Caddy has been reloaded/restarted with that Caddyfile at least once.

   Then, immediately after flipping the toggle, run the verification in §4 below — a failed
   verification here means the toggle should go back OFF while the mismatch is investigated,
   not left on against a broken trust chain.

6. **Keep the CA private key and a copy of the leaf's key safe, off the VPS, in more than one
   place.** `ammari-prod-aop-ca.key` and `client.key` both live in `~/ammari-secrets` (chmod 600)
   **and** a password manager — never only on one machine, and never on the VPS at all. The CA
   key is needed again for every future renewal (§3); losing it means re-doing this whole flow
   with a brand-new CA (and re-uploading a new CA root to the VPS) rather than a simple renewal.

## 3. Renewal, before the leaf expires in 2036

The leaf is deliberately short-lived relative to the CA (825 days vs. 10 years) specifically so
it gets renewed on a human cadence instead of being set once and forgotten. Two independent
reminders exist:

- **Cloudflare's own dashboard** emails the account's registered contacts ahead of a
  zone-level-AOP certificate's expiry — no separate monitoring needed for this specific date, but
  don't rely on it being the *only* thing that notices; put the 2036 expiry date in your own
  calendar too.
- The leaf's own `openssl x509 -enddate -noout -in client.pem` (keep a local copy of
  `client.pem` in `~/ammari-secrets` to check this without touching Cloudflare's dashboard).

**Procedure (no DNS or Caddy change needed — `trust_pool` trusts the CA, not this specific
leaf):**

1. On the owner's machine, using the **same** CA files from `~/ammari-secrets`
   (`ammari-prod-aop-ca.pem` / `.key` — never regenerate the CA itself for a routine renewal):
   ```bash
   openssl req -newkey rsa:2048 -nodes -keyout client.key -out client.csr \
     -subj "/CN=ammari-prod-origin-pull"
   openssl x509 -req -in client.csr -CA ammari-prod-aop-ca.pem -CAkey ammari-prod-aop-ca.key \
     -CAcreateserial -days 825 -out client.pem \
     -extfile <(printf "basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\n")
   ```
2. `ammari.id` zone → **SSL/TLS → Origin Server → Authenticated Origin Pulls → Zone-level** →
   upload the new `client.pem`/`client.key` pair — this **overwrites** the old pair in the same
   slot; there is no separate "add another" step.
3. Re-run the verification in §4 immediately after uploading, before considering the renewal
   done — the old leaf stops being presented the moment the new pair is uploaded, so a mismatch
   here means the origin is already broken, not just about to be.
4. Update the saved copy of `client.pem`/`client.key` in `~/ammari-secrets` and the password
   manager to the new pair; the CA root on the VPS (`origin-pull-ca.pem`) does **not** change.

## 4. Verification

**Before relying on any of the above**, `caddy validate` against the pinned image (same pattern
as dev's own README):

```bash
caddy validate --config /opt/ammari-prod/Caddyfile
```

**The real proof the AOP boundary holds** — a direct request to the origin, bypassing
Cloudflare entirely, must be rejected at the TLS layer before any HTTP response:

```bash
curl --resolve ammari.id:443:43.173.52.121 https://ammari.id/ -v
```

Expect a TLS handshake failure (`certificate_required` / `alert(116)` from Caddy, `curl` exit
code 35 or 56) — **not** a 403, not a normal page load. A normal page load here means either the
Zone-level toggle is still off while something else is serving traffic, or `trust_pool` is
pointed at the wrong CA — stop and re-check before going further, don't assume it'll "sort itself
out" once the toggle is flipped. This is the same check `docs/deploy.md` performs for dev's
Global AOP, repeated here because zone-level's failure mode is identical from the outside
(a rejected handshake) even though the trust chain underneath is entirely different.

Once the toggle is on and this curl rejection is confirmed, a normal request **through**
Cloudflare (`curl https://ammari.id/`) must still succeed — if it doesn't, Cloudflare isn't
actually presenting the uploaded leaf on real origin pulls, which would mean something was
uploaded to the wrong slot.
