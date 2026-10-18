import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import type { StorageClient } from "./client";

// A 7.6KB admin image upload PUT to Cloudeka (the current S3-compatible provider) was observed
// taking 113s instead of failing fast (see docs/deploy-prod.md's troubleshooting section) — this
// SDK version (3.1144.0, pinned since this package's introduction, already far past the ~3.729
// release where AWS SDK v3 changed its default) calculates a flexible checksum (CRC32) and
// streams it as an aws-chunked trailer on every request by default; some S3-compatible providers
// don't handle that trailer correctly and stall instead of rejecting it outright. WHEN_REQUIRED
// only computes/validates a checksum when the operation actually requires one (PutObject/
// DeleteObject don't), matching the pre-3.729 default. The timeouts+retries below turn a stall
// like that into a fast, clear failure (surfaced as the existing Indonesian "Gagal mengunggah ...
// ke penyimpanan. Coba lagi." error — see image-queries.ts/content-image-queries.ts) instead of
// hanging for minutes.
const CONNECTION_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;

// Safe only because every current caller of put() (apps/admin's product/content image upload
// paths, this package's own healthcheck writer — see docs/plans/storage-r2.md's "Decisions") puts
// each key exactly once and never overwrites it; a new upload always gets a brand-new storageKey
// (randomUUID()), and the old object is deleted, not replaced in place. If a future write path
// ever reuses a key, it must not go through this unconditional header — give it its own path with
// a short max-age instead.
const MEDIA_CACHE_CONTROL = "public, max-age=31536000, immutable";

export interface S3StorageClientConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Public URL prefix used to render images, e.g. "https://cdn.example.com" — no trailing
   * slash expected; one is added when building a key's URL. */
  publicBaseUrl: string;
}

/** `forcePathStyle: true` unconditionally — this client is only ever constructed for a custom
 * (non-AWS) endpoint, and self-hosted/S3-compatible providers (Cloudeka, Sumopod, MinIO, …)
 * aren't guaranteed to have the wildcard DNS virtual-hosted-style addressing needs. Revisit if a
 * specific provider documents virtual-hosted-style support and it matters. */
export class S3StorageClient implements StorageClient {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicBaseUrl: string;

  constructor(config: S3StorageClientConfig) {
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      maxAttempts: MAX_ATTEMPTS,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: CONNECTION_TIMEOUT_MS,
        requestTimeout: REQUEST_TIMEOUT_MS,
      }),
    });
    this.bucket = config.bucket;
    this.publicBaseUrl = config.publicBaseUrl.replace(/\/+$/, "");
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        CacheControl: MEDIA_CACHE_CONTROL,
      }),
    );
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  publicUrl(key: string): string {
    return `${this.publicBaseUrl}/${key}`;
  }
}
