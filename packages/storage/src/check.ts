// Db-free healthcheck: proves the bucket is reachable AND that objects under this prefix are
// publicly readable, without touching any application code or database. Run via
// `pnpm --filter @ammari/storage storage:check` (reads apps/admin/.env — see that script's
// --env-file flag). Never prints credential values, only which env vars are missing.
import { S3StorageClient } from "./s3-client";

const REQUIRED_ENV_VARS = [
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "STORAGE_PUBLIC_BASE_URL",
] as const;

function readConfig(): { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string; publicBaseUrl: string; prefix: string } {
  const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    console.error(`Missing required env var(s) in apps/admin/.env: ${missing.join(", ")}`);
    process.exit(1);
  }
  return {
    endpoint: process.env.S3_ENDPOINT!,
    region: process.env.S3_REGION!,
    bucket: process.env.S3_BUCKET!,
    accessKeyId: process.env.S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
    publicBaseUrl: process.env.STORAGE_PUBLIC_BASE_URL!,
    // S3_KEY_PREFIX is allowed to be unset/empty (root of the bucket) — unlike the vars above,
    // it is not a connection credential, so there is nothing unsafe about defaulting it.
    prefix: process.env.S3_KEY_PREFIX ?? "",
  };
}

function printPublicReadOptions(): void {
  console.log("");
  console.log("Public read did not work. Fix:");
  console.log("  Connect a Cloudflare custom domain to this bucket (R2 dashboard → bucket →");
  console.log("  Settings → Public access → Custom Domains) and point STORAGE_PUBLIC_BASE_URL at");
  console.log("  it. R2 has no bucket-policy API — public access is a whole-bucket property set");
  console.log("  once via a custom domain, not a per-prefix policy or per-object ACL.");
  console.log("");
  console.log("I will not change bucket settings myself — please connect the custom domain in the");
  console.log("Cloudflare dashboard, then re-run this check.");
}

async function main(): Promise<void> {
  const config = readConfig();
  const client = new S3StorageClient(config);
  const key = `${config.prefix}healthcheck/${Date.now()}.txt`;
  const body = Buffer.from("ammari storage check");

  console.log(`Writing test object: ${key}`);
  await client.put(key, body, "text/plain");

  try {
    const url = client.publicUrl(key);
    console.log(`Fetching public URL: ${url}`);
    const response = await fetch(url);
    if (!response.ok) {
      console.log(`GET returned ${response.status}.`);
      printPublicReadOptions();
      process.exitCode = 1;
      return;
    }
    const text = await response.text();
    if (text !== body.toString()) {
      console.log("GET succeeded but body did not match what was written.");
      printPublicReadOptions();
      process.exitCode = 1;
      return;
    }
    console.log("Public read works.");
  } catch (error) {
    console.log(`GET failed: ${error instanceof Error ? error.message : String(error)}`);
    printPublicReadOptions();
    process.exitCode = 1;
  } finally {
    console.log("Deleting test object.");
    await client.delete(key);
  }
}

main().catch((error: unknown) => {
  // Only the message, never the raw error object — an AWS SDK error can carry request/response
  // metadata (endpoint, headers) on properties like `$metadata`/`$response`, more than this
  // script's own promise ("never prints credential values") should risk putting in a terminal
  // or CI log.
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
