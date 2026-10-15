# Cloudflare origin TLS — manual setup (docs/deploy.md)

Two sets of files live here. Neither is committed to this repo as real bytes — a wrong TLS trust
anchor is worse than not automating it, so both are deliberately manual, one-time, on-the-VPS
steps (see docs/deploy.md for when to do this in the overall runbook).

## 1. The VPS's own origin certificate (`../caddy/certs/origin.pem`, `../caddy/certs/origin.key`)

Cloudflare dashboard → **SSL/TLS → Origin Server → Create Certificate**. Use the defaults (RSA,
15-year validity is fine — this cert is only ever presented to Cloudflare, never to a browser).
Hostnames: `ammari.my.id`, `www.ammari.my.id`, `admin.ammari.my.id` (and `*.ammari.my.id` if you'd
rather cover future subdomains in one go). Download both the certificate and the private key,
place them on the VPS at:

```
/opt/ammari/caddy/certs/origin.pem
/opt/ammari/caddy/certs/origin.key
```

`chmod 600` the key. These two files are what `deploy/Caddyfile`'s `tls` directive loads.
Confirmed (via a real `caddy:2.10.2` container, no override) that the official Caddy image runs
its process as root, which can read a mode-600 file owned by any user (root bypasses the
owner/group permission check) — so `chmod 600`, owned by whichever user did the `curl`/upload
(typically `deploy`), is fine as-is; no extra `chown` or looser mode needed for Caddy to read it.

## 2. The Cloudflare origin-pull CA (`origin-pull-ca.pem`, this directory)

This is what makes **Authenticated Origin Pulls** work. Cloudflare's dashboard has **three**
separate AOP toggles under **SSL/TLS → Origin Server** — picking the wrong one is the single
easiest way to break this:

- **Global** — Cloudflare presents its own shared client certificate (the one `origin-pull-ca.pem`
  below verifies) on every origin pull, for every zone with this toggle on. **This is what dev
  uses.** No certificate to upload; just enable the toggle.
- **Zone-level** — Cloudflare instead presents a *custom* client certificate you've uploaded for
  this specific zone. **Must stay OFF for dev** unless you've actually uploaded one: with
  Zone-level ON and no certificate uploaded, Cloudflare presents **no client certificate at all**
  on the handshake — and because TLS 1.3 delivers the "certificate required" alert *after* the
  handshake completes (not during), Cloudflare's edge sees what looks like a succeeding
  connection that then gets cut off, and reports it to the browser as a generic **Cloudflare
  error 520** ("web server returned an unknown error"), not anything that points at TLS or
  certificates. If dev (or prod) ever starts throwing 520s with Caddy itself logging nothing
  useful, check this toggle first.
- **Per-hostname** — even more granular than zone-level (Enterprise); not used here.
- **Prod, later**: if prod ever needs Zone-level instead of Global (e.g. to use a cert dev
  doesn't share), that means (a) generating/uploading our own client certificate as that zone's
  one, AND (b) changing `deploy/Caddyfile`'s `trust_pool` to point at **our own** CA instead of
  `authenticated_origin_pull_ca.pem` — Global and Zone-level are not two paths to the same
  trust anchor, they're genuinely different certificates on both ends.

Confirm **Global** AOP is the one enabled, then fetch the fixed CA it presents — a separate,
publicly-published file, not downloaded from the dashboard:

```bash
curl -fsSL https://developers.cloudflare.com/ssl/static/authenticated_origin_pull_ca.pem \
  -o /opt/ammari/cloudflare/origin-pull-ca.pem
```

Confirmed (during development) to be a self-signed cert with
`CN=origin-pull.cloudflare.net, OU=Origin Pull`, valid until 2029 — same for every Cloudflare
account, not customer-specific, which is why a `curl` one-liner is enough; no dashboard download
needed for this file at all. This is what `deploy/Caddyfile`'s
`client_auth { trust_pool file { pem_file ... } } }` reads — without it, Caddy will reject every
request (nothing to verify client certs against), which is the fail-closed behavior you want if
this step is ever skipped.

## Verify before relying on either

```bash
caddy validate --config /opt/ammari/Caddyfile
```

against the Caddy version actually installed/running on the VPS (this repo pins `caddy:2.10.2`
in `deploy/docker-compose.yml` — confirmed working syntax, including the `trust_pool` form, was
validated against that exact image during development). Then docs/deploy.md's own
"curl the VPS IP directly, bypassing Cloudflare, must fail" step — that's the real proof this is
actually enforced, not just configured.
