import "server-only";
import path from "node:path";
import { createPrivateStorageClientFromEnv, type PrivateStorageClient } from "@ammari/storage";

// Process-wide, not module-scoped: `next dev` bundles server actions and route handlers into
// separate module graphs, so a module-level `let` gives each its own client. For the memory driver
// (e2e) that means a proof stored by the "Catat pembayaran" action would be invisible to
// /api/private-files. One client per process is right for every driver.
const GLOBAL_KEY = Symbol.for("ammari.admin.privateStorageClient");
type GlobalWithClient = typeof globalThis & { [GLOBAL_KEY]?: PrivateStorageClient };
const store = globalThis as GlobalWithClient;

/** Lazy singleton for the PRIVATE file storage (payment proofs, supplier notas;
 * docs/plans/purchase-payments.md §5). Constructed on first use, so pages that never touch a
 * proof need none of its env. Throws PrivateStorageConfigError when unconfigured (never falls back
 * to the public media storage, src/lib/storage.ts); callers show "Penyimpanan bukti belum
 * dikonfigurasi." Drivers: PRIVATE_STORAGE_DRIVER=memory (e2e), =fs (local dev, files in the git-
 * and docker-ignored apps/admin/.private-storage/), unset = the private S3 bucket. memory and fs
 * are refused when NODE_ENV=production. */
export function getPrivateStorageClient(): PrivateStorageClient {
  const existing = store[GLOBAL_KEY];
  if (existing) return existing;
  const client = createPrivateStorageClientFromEnv(process.env, {
    fsRootDir: path.join(process.cwd(), ".private-storage"),
  });
  store[GLOBAL_KEY] = client;
  return client;
}

/** Test-only: inject a client (e.g. an InMemoryPrivateStorageClient to assert on `.objects`).
 * Never imported from application code. */
export function __setPrivateStorageClientForTests(client: PrivateStorageClient | undefined): void {
  store[GLOBAL_KEY] = client;
}
