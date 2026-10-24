import { PrivateStorageConfigError, type PrivateStorageClient } from "./private-client";
import { FsPrivateStorageClient } from "./private-fs-client";
import { InMemoryPrivateStorageClient } from "./private-memory-client";
import { S3PrivateStorageClient } from "./private-s3-client";

export const PRIVATE_S3_ENV_VARS = [
  "S3_ENDPOINT",
  "S3_REGION",
  "PRIVATE_S3_BUCKET",
  "PRIVATE_S3_ACCESS_KEY_ID",
  "PRIVATE_S3_SECRET_ACCESS_KEY",
] as const;

type Env = Record<string, string | undefined>;

export interface PrivateStorageEnvOptions {
  /** Where PRIVATE_STORAGE_DRIVER=fs keeps its files (a git- and docker-ignored folder). */
  fsRootDir: string;
}

/** Builds the private storage client from env (docs/plans/purchase-payments.md §5.5). Fails
 * closed, never falls back:
 *
 * - `PRIVATE_STORAGE_DRIVER=memory` (e2e/tests) and `=fs` (local dev) are accepted only when
 *   NODE_ENV is "development" or "test" (`next dev`, vitest). Anything else, unset included, is
 *   refused, so every real deploy (a production build, dev server included) needs the bucket.
 * - Unset means the private S3 bucket. Every PRIVATE_S3_* var plus the shared S3_ENDPOINT /
 *   S3_REGION must be set; there is no default to the media bucket.
 * - The bucket name must end in "-private" (ammari-dev-private, ammari-prod-private), and must
 *   not be the media bucket; the credentials must not be the media token's. The media buckets
 *   are public as a whole, and the media token must never see proofs. Whether the bucket really
 *   has no public domain cannot be checked over the S3 API (manual deploy checklist item).
 *
 * Never puts a credential value in an error message, only env var names. */
export function createPrivateStorageClientFromEnv(env: Env, options: PrivateStorageEnvOptions): PrivateStorageClient {
  const driver = env.PRIVATE_STORAGE_DRIVER?.trim() ?? "";
  const isLocal = env.NODE_ENV === "development" || env.NODE_ENV === "test";

  if (driver === "memory" || driver === "fs") {
    if (!isLocal) {
      throw new PrivateStorageConfigError(
        `PRIVATE_STORAGE_DRIVER=${driver} is only allowed when NODE_ENV is development or test (got ` +
          `${env.NODE_ENV ? `"${env.NODE_ENV}"` : "unset"}). It is for e2e/tests (memory) and local development (fs); ` +
          "a deploy must use the private S3 bucket.",
      );
    }
    return driver === "memory" ? new InMemoryPrivateStorageClient() : new FsPrivateStorageClient(options.fsRootDir);
  }
  if (driver !== "") {
    throw new PrivateStorageConfigError(`Unknown PRIVATE_STORAGE_DRIVER "${driver}". Use "memory", "fs", or leave it unset for S3.`);
  }

  const missing = PRIVATE_S3_ENV_VARS.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new PrivateStorageConfigError(
      `Missing required env var(s) for private file storage: ${missing.join(", ")}. ` +
        "Private files are never written to the public media bucket instead.",
    );
  }
  const bucket = env.PRIVATE_S3_BUCKET!.trim();
  const accessKeyId = env.PRIVATE_S3_ACCESS_KEY_ID!.trim();
  if (!/-private$/.test(bucket)) {
    throw new PrivateStorageConfigError('PRIVATE_S3_BUCKET must be a private bucket whose name ends in "-private".');
  }
  if (env.S3_BUCKET?.trim() === bucket) {
    throw new PrivateStorageConfigError("PRIVATE_S3_BUCKET must not be the media bucket (S3_BUCKET): the media bucket is public.");
  }
  if (env.S3_ACCESS_KEY_ID?.trim() === accessKeyId || (env.S3_SECRET_ACCESS_KEY !== undefined && env.S3_SECRET_ACCESS_KEY === env.PRIVATE_S3_SECRET_ACCESS_KEY)) {
    throw new PrivateStorageConfigError(
      "PRIVATE_S3_ACCESS_KEY_ID / PRIVATE_S3_SECRET_ACCESS_KEY must not be the media token's: use a token scoped to the private bucket only.",
    );
  }

  return new S3PrivateStorageClient({
    endpoint: env.S3_ENDPOINT!.trim(),
    region: env.S3_REGION!.trim(),
    bucket,
    accessKeyId,
    secretAccessKey: env.PRIVATE_S3_SECRET_ACCESS_KEY!,
  });
}
