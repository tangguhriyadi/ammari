import "server-only";
import { InMemoryStorageClient, S3StorageClient, type StorageClient } from "@ammari/storage";

const REQUIRED_S3_ENV_VARS = [
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "STORAGE_PUBLIC_BASE_URL",
] as const;

let cached: StorageClient | undefined;

/** Lazy singleton — constructed on first use, not at module load, so pages that never touch
 * images don't need S3 env vars configured at all. `STORAGE_DRIVER=memory` swaps in the
 * in-memory fake (set only by playwright.config.ts's webServer.env for e2e runs, same mechanism
 * as E2E_TEST_LOGIN) — and, like that backdoor, fails closed: refused outright in production,
 * never silently ignored, so a misconfigured deploy can't accidentally serve every admin image
 * upload into a throwaway in-memory store that vanishes on the next request. */
export function getStorageClient(): StorageClient {
  if (cached) return cached;

  if (process.env.STORAGE_DRIVER === "memory") {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "STORAGE_DRIVER=memory is not allowed when NODE_ENV=production. This is an e2e-only " +
          "escape hatch (see playwright.config.ts) and must never reach a real deploy.",
      );
    }
    cached = new InMemoryStorageClient();
    return cached;
  }

  const missing = REQUIRED_S3_ENV_VARS.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required env var(s) for product image storage: ${missing.join(", ")}. ` +
        "Fill these in apps/admin/.env (see .env.example) — never logged or committed.",
    );
  }

  cached = new S3StorageClient({
    endpoint: process.env.S3_ENDPOINT!,
    region: process.env.S3_REGION!,
    bucket: process.env.S3_BUCKET!,
    accessKeyId: process.env.S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
    publicBaseUrl: process.env.STORAGE_PUBLIC_BASE_URL!,
  });
  return cached;
}

/** The configured key prefix — "" when unset (root of the bucket), same default as
 * packages/storage/src/check.ts. Exported separately from the client because callers build
 * object keys themselves (see lib/products/image-keys.ts). */
export function getStorageKeyPrefix(): string {
  return process.env.S3_KEY_PREFIX ?? "";
}

/** Test-only escape hatch so a test file can inject its own InMemoryStorageClient instance
 * (e.g. to assert on `.objects` directly) instead of only ever getting whatever the first call
 * in the process happened to construct. Never imported from application code. */
export function __setStorageClientForTests(client: StorageClient | undefined): void {
  cached = client;
}
