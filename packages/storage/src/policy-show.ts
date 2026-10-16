// Reads back the policy currently applied to the real bucket (S3's GetBucketPolicy API) — a
// read-only companion to policy-apply.ts, useful to confirm what's actually live without
// risking a write. Run via: pnpm --filter @ammari/storage policy:show
// Reads S3_* credentials from apps/admin/.env, same as policy-apply.ts. Never prints a
// credential value.
import { GetBucketPolicyCommand, S3Client } from "@aws-sdk/client-s3";
import { readPolicyEnvConfig } from "./policy";

async function main(): Promise<void> {
  const config = readPolicyEnvConfig();
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });

  console.log(`Fetching the live bucket policy for "${config.bucket}"...`);
  try {
    const response = await client.send(new GetBucketPolicyCommand({ Bucket: config.bucket }));
    const parsed = response.Policy ? JSON.parse(response.Policy) : null;
    console.log(parsed ? JSON.stringify(parsed, null, 2) : "(empty policy document)");
  } catch (error) {
    const name = error instanceof Error ? error.name : undefined;
    if (name === "NoSuchBucketPolicy") {
      console.log("No bucket policy is currently applied — the bucket has no public-read access at all.");
      return;
    }
    throw error;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
