// Applies packages/storage/bucket-policy.<env>.json to the real bucket via S3's PutBucketPolicy
// API, then verifies the result with anonymous (unsigned) HTTP requests — a public prefix must
// come back 200, a private one 403. Run via:
//   pnpm --filter @ammari/storage policy:apply -- --env dev [--dry-run]
// Reads S3_* credentials from apps/admin/.env (same vars that app's own storage.ts requires —
// see this script's package.json entry for the --env-file flag). Never prints a credential
// value, only which env var names are missing.
import { PutBucketPolicyCommand, S3Client } from "@aws-sdk/client-s3";
import { S3StorageClient } from "./s3-client";
import {
  bucketNameFromPolicy,
  buildVerifyTargets,
  loadPolicyFile,
  parsePolicyArgs,
  readPolicyEnvConfig,
  type PolicyEnvConfig,
} from "./policy";

async function verify(config: PolicyEnvConfig): Promise<boolean> {
  const client = new S3StorageClient(config);
  const { publicKey, privateKey } = buildVerifyTargets(config.keyPrefix);
  const body = Buffer.from("ammari policy verify");

  console.log(`Uploading temporary verify objects: ${publicKey}, ${privateKey}`);
  await client.put(publicKey, body, "text/plain");
  await client.put(privateKey, body, "text/plain");

  let publicOk = false;
  let privateOk = false;
  try {
    const publicUrl = client.publicUrl(publicKey);
    console.log(`Checking public prefix (expect 200): ${publicUrl}`);
    const publicResponse = await fetch(publicUrl);
    publicOk = publicResponse.status === 200;
    console.log(publicOk ? "  OK: 200" : `  FAIL: got ${publicResponse.status}, expected 200`);

    const privateUrl = client.publicUrl(privateKey);
    console.log(`Checking private prefix (expect 403): ${privateUrl}`);
    const privateResponse = await fetch(privateUrl);
    privateOk = privateResponse.status === 403;
    console.log(privateOk ? "  OK: 403" : `  FAIL: got ${privateResponse.status}, expected 403`);
  } finally {
    console.log("Deleting temporary verify objects.");
    await client.delete(publicKey);
    await client.delete(privateKey);
  }

  return publicOk && privateOk;
}

async function main(): Promise<void> {
  const { env, dryRun } = parsePolicyArgs(process.argv.slice(2));
  const { policy, policyJson } = loadPolicyFile(env);

  if (dryRun) {
    console.log(`Policy that would be applied for --env ${env}:\n`);
    console.log(policyJson);
    return;
  }

  const config = readPolicyEnvConfig();

  const policyBucket = bucketNameFromPolicy(policy);
  if (policyBucket && policyBucket !== config.bucket) {
    throw new Error(
      `bucket-policy.${env}.json targets bucket "${policyBucket}" but S3_BUCKET is "${config.bucket}" — ` +
        "refusing to apply a policy written for a different bucket than the one these credentials point at.",
    );
  }

  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });

  console.log(`Applying bucket-policy.${env}.json to bucket "${config.bucket}"...`);
  try {
    await client.send(new PutBucketPolicyCommand({ Bucket: config.bucket, Policy: JSON.stringify(policy) }));
  } catch (error) {
    console.error("PutBucketPolicy was rejected by the provider. Exact error:");
    console.error(error instanceof Error ? error.message : String(error));
    console.error("\nTell the owner this exact error — the provider (Cloudeka) may not support PutBucketPolicy at all.");
    process.exitCode = 1;
    return;
  }
  console.log("Policy applied. Verifying with anonymous HTTP requests...");

  const ok = await verify(config);
  if (!ok) {
    console.error("\nVerification FAILED — see details above.");
    process.exitCode = 1;
    return;
  }
  console.log("\nVerification passed: public prefix is readable, private prefix is not.");
}

main().catch((error: unknown) => {
  // Message only — never the raw error object, which can carry request/response metadata (see
  // src/check.ts's own identical reasoning).
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
