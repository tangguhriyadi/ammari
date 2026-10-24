import "server-only";
import path from "node:path";
import { createPrivateStorageClientFromEnv, type PrivateStorageClient } from "@ammari/storage";

let cached: PrivateStorageClient | undefined;

/** Lazy singleton for the PRIVATE file storage (payment proofs, supplier notas;
 * docs/plans/purchase-payments.md §5). Constructed on first use, so pages that never touch a
 * proof need none of its env. Throws PrivateStorageConfigError when unconfigured (never falls back
 * to the public media storage, src/lib/storage.ts); callers show "Penyimpanan bukti belum
 * dikonfigurasi." Drivers: PRIVATE_STORAGE_DRIVER=memory (e2e), =fs (local dev, files in the git-
 * and docker-ignored apps/admin/.private-storage/), unset = the private S3 bucket. memory and fs
 * are refused when NODE_ENV=production. */
export function getPrivateStorageClient(): PrivateStorageClient {
  if (cached) return cached;
  cached = createPrivateStorageClientFromEnv(process.env, {
    fsRootDir: path.join(process.cwd(), ".private-storage"),
  });
  return cached;
}

/** Test-only: inject a client (e.g. an InMemoryPrivateStorageClient to assert on `.objects`).
 * Never imported from application code. */
export function __setPrivateStorageClientForTests(client: PrivateStorageClient | undefined): void {
  cached = client;
}
