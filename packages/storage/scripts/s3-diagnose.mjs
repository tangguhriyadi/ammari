#!/usr/bin/env node
// Diagnostic for the Cloudeka S3 PUT stall (docs/deploy-prod.md's troubleshooting section) —
// isolates WHICH client behavior is responsible by running the SAME 8KB PUT+DELETE through four
// progressively-stripped-down configurations and timing each, instead of guessing. Reads the
// S3_* env vars the admin app already uses (storage.ts's REQUIRED_S3_ENV_VARS) and NEVER prints
// their values — only timings, HTTP/SDK status, and error codes.
//
// Plain Node, ESM (.mjs so the nearest package.json's "type" field never matters) — no tsx, no
// extra dependency beyond what @ammari/storage already needs (@aws-sdk/client-s3,
// @smithy/node-http-handler), which the running admin process already has in its node_modules.
// See docs/deploy-prod.md for the exact command to run this inside the deployed admin container.
//
// Also doubles as the pre-migration R2-vs-Cloudeka comparison tool (docs/plans/storage-r2.md) and
// stays useful post-migration for diagnosing any *future* provider's latency the same way — point
// it at the candidate provider's S3_* vars and compare against the incumbent.
//
// Variants (3 PUT+DELETE cycles each, timing the PUT only):
//   A  current production client config (packages/storage/src/s3-client.ts, unmodified copy)
//   B  A + expectContinueHeader: false
//   C  B + keepAlive disabled on the https agent
//   D  raw signed PUT via fetch, hand-rolled AWS SigV4 (Node's own crypto, no AWS SDK at all) —
//      bypasses the SDK's HTTP handler entirely: no Expect header, no aws-chunked/checksum
//      trailer, no long-lived keep-alive agent. A baseline control, not a "real" client.
//
// Also instruments node:https directly (A/B/C only — D never touches it) to report, per
// variant: how many requests actually carried "Expect: 100-continue", and how many "100
// Continue" responses were ever received — see @smithy/node-http-handler's own
// writeRequestBody()/handle() for exactly where this matters (a missing 100-continue response
// is waited on for up to max(6000, requestTimeout) ms before the body is sent anyway).

import { createHash, createHmac } from "node:crypto";
import https from "node:https";
import { performance } from "node:perf_hooks";

const REQUIRED_ENV = ["S3_ENDPOINT", "S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"];
const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`Missing required env var(s): ${missing.join(", ")}`);
  process.exit(1);
}

const ENDPOINT = process.env.S3_ENDPOINT;
const REGION = process.env.S3_REGION;
const BUCKET = process.env.S3_BUCKET;
const ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID;
const SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY;

const RUNS_PER_VARIANT = 3;
const BODY = Buffer.alloc(8192, 0x41); // 8KB, deterministic content — only the size matters here
const CONTENT_TYPE = "application/octet-stream";

function redact(text) {
  // Defensive only — none of the error shapes this script ever prints should include these, but
  // never let raw credential material reach stdout/stderr under any circumstance.
  return String(text).split(SECRET_ACCESS_KEY).join("***").split(ACCESS_KEY_ID).join("***");
}

function diagKey() {
  return `healthcheck/_diag/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.bin`;
}

function summarize(samples) {
  const okMs = samples.filter((sample) => sample.ok).map((sample) => sample.ms);
  const failures = samples.filter((sample) => !sample.ok).map((sample) => ({ name: sample.name, code: sample.code }));
  return {
    minMs: okMs.length ? Math.min(...okMs) : null,
    avgMs: okMs.length ? Math.round(okMs.reduce((a, b) => a + b, 0) / okMs.length) : null,
    maxMs: okMs.length ? Math.max(...okMs) : null,
    failures,
  };
}

// ---------- node:https instrumentation (variants A/B/C only) ----------
//
// @smithy/node-http-handler always issues the actual request via `node_https.request(options,
// callback)` for an https: URL (confirmed by reading the installed package's own source,
// dist-cjs/index.js) — no URL-object overload, so `args[0]` is reliably the options object this
// handler builds, never a WHATWG URL.

let expectHeaderSeen = 0;
let continueReceived = 0;
const originalHttpsRequest = https.request;
https.request = function patchedHttpsRequest(...args) {
  const req = originalHttpsRequest.apply(https, args);
  try {
    const options = args[0];
    const expectHeader = options?.headers?.Expect ?? options?.headers?.expect;
    if (expectHeader === "100-continue") expectHeaderSeen += 1;
  } catch {
    // best-effort only — instrumentation must never break the actual measurement
  }
  req.on("continue", () => {
    continueReceived += 1;
  });
  return req;
};

// ---------- Variants A/B/C: real AWS SDK client, progressively stripped down ----------

async function runSdkVariant(name, buildClientOptions) {
  const { S3Client, PutObjectCommand, DeleteObjectCommand } = await import("@aws-sdk/client-s3");
  const { NodeHttpHandler } = await import("@smithy/node-http-handler");

  const client = new S3Client({
    endpoint: ENDPOINT,
    region: REGION,
    forcePathStyle: true,
    credentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    maxAttempts: 3,
    ...buildClientOptions(NodeHttpHandler),
  });

  expectHeaderSeen = 0;
  continueReceived = 0;

  const samples = [];
  for (let i = 0; i < RUNS_PER_VARIANT; i++) {
    const key = diagKey();
    const started = performance.now();
    try {
      await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: BODY, ContentType: CONTENT_TYPE }));
      samples.push({ ok: true, ms: Math.round(performance.now() - started) });
    } catch (error) {
      samples.push({ ok: false, ms: Math.round(performance.now() - started), name: error?.name, code: error?.code ?? error?.Code });
    } finally {
      try {
        await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
      } catch {
        // best-effort cleanup — a failed delete of a throwaway diagnostic object doesn't matter
      }
    }
  }
  client.destroy();
  return { name, ...summarize(samples), expectHeaderSeen, continueReceived };
}

// ---------- Variant D: raw signed PUT via fetch — hand-rolled AWS SigV4 using only Node's own
// `crypto` module (no @aws-sdk/*, no @smithy/signature-v4) — a genuinely independent HTTP stack
// (undici, not node:http's Agent machinery) as a baseline control, not a real client. ----------

function hmac(key, data) {
  return createHmac("sha256", key).update(data).digest();
}
function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}
function amzTimestamp(date) {
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

/** Signs and sends one request with SigV4 — path-style, same as the real client. Node's fetch
 * (undici) overrides a manually-set `Host` header with the URL's own host and validates a
 * manually-set `Content-Length` against the real body length (confirmed empirically) rather
 * than silently ignoring either, so signing against the SAME values fetch will actually send is
 * enough; no special-casing needed for those two headers. */
async function signedS3Request(method, key, body) {
  const url = new URL(`${ENDPOINT.replace(/\/+$/, "")}/${BUCKET}/${key}`);
  const payloadHash = sha256Hex(body ?? Buffer.alloc(0));
  const { amzDate, dateStamp } = amzTimestamp(new Date());

  const headersToSign = { host: url.host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  if (body) {
    headersToSign["content-length"] = String(body.length);
    headersToSign["content-type"] = CONTENT_TYPE;
  }
  const sortedNames = Object.keys(headersToSign).sort();
  const canonicalHeaders = sortedNames.map((headerName) => `${headerName}:${headersToSign[headerName]}\n`).join("");
  const signedHeaders = sortedNames.join(";");
  const canonicalRequest = [method, url.pathname, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");

  const credentialScope = `${dateStamp}/${REGION}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(Buffer.from(canonicalRequest))].join("\n");

  const kDate = hmac(`AWS4${SECRET_ACCESS_KEY}`, dateStamp);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = hmac(kSigning, stringToSign).toString("hex");

  const headers = {
    "X-Amz-Content-Sha256": payloadHash,
    "X-Amz-Date": amzDate,
    Authorization:
      `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY_ID}/${credentialScope}, ` + `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
  if (body) {
    headers["Content-Length"] = String(body.length);
    headers["Content-Type"] = CONTENT_TYPE;
  }

  return fetch(url, { method, headers, body: method === "PUT" ? body : undefined });
}

async function runRawFetchVariant() {
  const samples = [];
  for (let i = 0; i < RUNS_PER_VARIANT; i++) {
    const key = diagKey();
    const started = performance.now();
    try {
      const response = await signedS3Request("PUT", key, BODY);
      const ms = Math.round(performance.now() - started);
      if (response.ok) samples.push({ ok: true, ms });
      else samples.push({ ok: false, ms, code: `HTTP ${response.status}` });
    } catch (error) {
      samples.push({ ok: false, ms: Math.round(performance.now() - started), name: error?.name, code: error?.code });
    } finally {
      try {
        await signedS3Request("DELETE", key, null);
      } catch {
        // best-effort cleanup
      }
    }
  }
  return { name: "D (raw fetch, no SDK)", ...summarize(samples), expectHeaderSeen: "n/a", continueReceived: "n/a" };
}

// ---------- main ----------

function fmtMs(ms) {
  return ms === null ? "FAIL" : `${ms}ms`;
}

function printResult(result) {
  const failurePart = result.failures?.length ? ` FAILURES=${JSON.stringify(result.failures)}` : "";
  console.log(
    `${result.name.padEnd(36)} min=${fmtMs(result.minMs)} avg=${fmtMs(result.avgMs)} max=${fmtMs(result.maxMs)} ` +
      `expectHeaderSeen=${result.expectHeaderSeen} continueReceived=${result.continueReceived}${failurePart}`,
  );
}

async function main() {
  console.log(`S3 diagnose — endpoint=${ENDPOINT} bucket=${BUCKET} region=${REGION} (credentials never printed)`);
  console.log(`${RUNS_PER_VARIANT} PUT+DELETE cycles per variant, 8KB body\n`);

  const results = [];

  results.push(
    await runSdkVariant("A (current prod config)", (NodeHttpHandler) => ({
      requestHandler: new NodeHttpHandler({ connectionTimeout: 5_000, requestTimeout: 30_000 }),
    })),
  );
  printResult(results.at(-1));

  results.push(
    await runSdkVariant("B (A + expectContinueHeader:false)", (NodeHttpHandler) => ({
      expectContinueHeader: false,
      requestHandler: new NodeHttpHandler({ connectionTimeout: 5_000, requestTimeout: 30_000 }),
    })),
  );
  printResult(results.at(-1));

  results.push(
    await runSdkVariant("C (B + keepAlive:false)", (NodeHttpHandler) => ({
      expectContinueHeader: false,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: 5_000,
        requestTimeout: 30_000,
        httpsAgent: { keepAlive: false },
      }),
    })),
  );
  printResult(results.at(-1));

  results.push(await runRawFetchVariant());
  printResult(results.at(-1));

  https.request = originalHttpsRequest;

  console.log("\n--- summary (copy this whole block back) ---");
  for (const result of results) printResult(result);
}

main().catch((error) => {
  console.error("s3-diagnose failed:", redact(error?.stack ?? error?.message ?? String(error)));
  process.exitCode = 1;
});
