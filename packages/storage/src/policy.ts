import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Pure/filesystem-only helpers shared by policy-apply.ts and policy-show.ts — kept separate from
// those two thin CLI entrypoints (and from any network call) so argument parsing, comment-
// stripping and the placeholder guard are unit-testable without a real bucket. Mirrors the
// "pure, testable gate + thin route" split this codebase already uses for e2e backdoors (see
// apps/web/src/lib/preview/e2e-gate.ts).

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export type PolicyEnv = "dev" | "prod";

export interface PolicyApplyArgs {
  env: PolicyEnv;
  dryRun: boolean;
}

/** Parses the argv this script receives after `--` (e.g. `["--env", "dev", "--dry-run"]`). */
export function parsePolicyArgs(argv: string[]): PolicyApplyArgs {
  let env: string | undefined;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--env") {
      env = argv[++i];
    } else if (argv[i] === "--dry-run") {
      dryRun = true;
    }
  }
  if (env !== "dev" && env !== "prod") {
    throw new Error(`--env must be "dev" or "prod" (got ${env ? `"${env}"` : "nothing"}).`);
  }
  return { env, dryRun };
}

export function policyFilePath(env: PolicyEnv): string {
  return join(PACKAGE_ROOT, `bucket-policy.${env}.json`);
}

/** Strips documentation-only top-level keys (leading "_", e.g. `_comment`) — real S3-compatible
 * APIs reject a PutBucketPolicy body with unrecognized top-level keys, so these can live in the
 * committed JSON for humans but must never reach the actual API call. */
export function stripPolicyComments(raw: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!key.startsWith("_")) result[key] = value;
  }
  return result;
}

export interface LoadedPolicy {
  policy: Record<string, unknown>;
  policyJson: string;
}

/** Reads and validates one `bucket-policy.<env>.json` file. Throws if it still has the prod
 * template's unfilled placeholder — applying that literally would scope the public-read
 * statement to a bucket named "REPLACE_WITH_PROD_BUCKET_NAME", not refuse. */
export function loadPolicyFile(env: PolicyEnv): LoadedPolicy {
  const path = policyFilePath(env);
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const policy = stripPolicyComments(raw);
  const policyJson = JSON.stringify(policy, null, 2);
  if (policyJson.includes("REPLACE_WITH_PROD_BUCKET_NAME")) {
    throw new Error(`${path} still has the REPLACE_WITH_PROD_BUCKET_NAME placeholder — fill in the real prod bucket name first.`);
  }
  return { policy, policyJson };
}

/** Pulls the bucket name out of the policy's own Resource ARNs, so apply can refuse outright
 * when the credentials' S3_BUCKET env var doesn't match the bucket this policy file was written
 * for — e.g. running `--env dev` with prod credentials loaded by mistake. */
export function bucketNameFromPolicy(policy: Record<string, unknown>): string | null {
  const statements = policy.Statement;
  if (!Array.isArray(statements)) return null;
  for (const statement of statements) {
    const resource = (statement as { Resource?: unknown } | null)?.Resource;
    const resources = Array.isArray(resource) ? resource : [resource];
    for (const entry of resources) {
      if (typeof entry !== "string") continue;
      const match = /^arn:aws:s3:::([^/]+)\//.exec(entry);
      if (match?.[1]) return match[1];
    }
  }
  return null;
}

export const REQUIRED_POLICY_ENV_VARS = [
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "STORAGE_PUBLIC_BASE_URL",
] as const;

export interface PolicyEnvConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl: string;
  /** S3_KEY_PREFIX is allowed to be unset/empty (root of the bucket), same default as
   * src/check.ts — it is not a credential, so defaulting it is not unsafe. */
  keyPrefix: string;
}

/** Reads the same S3_* vars apps/admin's own storage.ts requires — deliberately never logs a
 * value, only which names are missing. */
export function readPolicyEnvConfig(): PolicyEnvConfig {
  const missing = REQUIRED_POLICY_ENV_VARS.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing required env var(s): ${missing.join(", ")}`);
  }
  return {
    endpoint: process.env.S3_ENDPOINT!,
    region: process.env.S3_REGION!,
    bucket: process.env.S3_BUCKET!,
    accessKeyId: process.env.S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
    publicBaseUrl: process.env.STORAGE_PUBLIC_BASE_URL!.replace(/\/+$/, ""),
    keyPrefix: process.env.S3_KEY_PREFIX ?? "",
  };
}

export interface VerifyTargets {
  publicKey: string;
  privateKey: string;
}

/** Deterministic (timestamp-namespaced, so repeated runs never collide) test object keys: one
 * under `products/*` (must come back public) and one at the prefix root, outside every
 * public-read statement (must come back private). */
export function buildVerifyTargets(keyPrefix: string): VerifyTargets {
  const stamp = Date.now();
  return {
    publicKey: `${keyPrefix}products/_policy-verify-${stamp}.txt`,
    privateKey: `${keyPrefix}_policy-verify-private-${stamp}.txt`,
  };
}
