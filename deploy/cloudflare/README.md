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

This is what makes **Authenticated Origin Pulls** work. Cloudflare dashboard → **SSL/TLS →
Origin Server**, enable **"Authenticated Origin Pulls"** — but do **NOT** download the
"Cloudflare Origin CA Root Certificate" shown on that same page; that one verifies *origin*
certificates (the opposite direction, and not what `client_auth` here checks). The certificate
that signs Cloudflare's own client certs for origin pulls is a separate, fixed file Cloudflare
publishes directly:

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
