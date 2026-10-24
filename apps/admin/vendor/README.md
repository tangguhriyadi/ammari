# Vendored packages

## `xlsx-0.20.3.tgz` (SheetJS Community Edition)

The spreadsheet reader behind the marketplace order import (`src/lib/marketplace-import/`,
docs/plans/marketplace-import.md §10). Server-only; never shipped to the browser.

- Source: `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` (the official SheetJS CDN; SheetJS
  no longer publishes to the npm registry).
- sha256: `8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8`
- License: Apache-2.0. No dependencies, no install scripts (checked in its `package.json`).
- Depended on as `"xlsx": "file:vendor/xlsx-0.20.3.tgz"`; `pnpm-lock.yaml` pins the tarball's
  sha512 integrity, so a changed file fails `pnpm install --frozen-lockfile`.
- Docker: `turbo prune --docker` copies `file:` tarballs into `out/json`, so the admin image's
  install step finds it without a Dockerfile change (checked with a local prune, 2026-10-24).

**Never replace it with the npm-registry `xlsx@0.18.5`**: abandoned there, with published advisories
(prototype pollution CVE-2023-30533, ReDoS CVE-2024-22363) fixed only in SheetJS-hosted builds.

`pnpm audit` and Renovate do not watch this file. Check https://cdn.sheetjs.com/ and the SheetJS
changelog for security releases at each prod release.

Upgrading: download the new tarball from the CDN, verify it (`shasum -a 256`; inspect its
`package.json` for `dependencies` and install scripts), replace the file, update the
`package.json` specifier and this README, run `pnpm install`, then the marketplace-import tests.
