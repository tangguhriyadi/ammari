import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { assertValidPrivateKey, PrivateObjectExistsError, type PrivateStorageClient } from "./private-client";
import { createS3Client, isS3NotFound, s3HttpStatus, type S3ConnectionConfig } from "./s3-client";

// Never the media client's "public, max-age=31536000, immutable": these objects must never sit in
// a shared cache. The admin route sets its own headers; this only covers a direct bucket read.
const PRIVATE_CACHE_CONTROL = "private, no-store";

export interface S3PrivateStorageClientConfig extends S3ConnectionConfig {
  /** The PRIVATE bucket (ammari-{dev,prod}-private), never a public media bucket. */
  bucket: string;
}

/** The private bucket over the S3 API (docs/plans/purchase-payments.md §5). Upload and read only:
 * this class has no delete and no URL builder on purpose. */
export class S3PrivateStorageClient implements PrivateStorageClient {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: S3PrivateStorageClientConfig) {
    this.client = createS3Client(config);
    this.bucket = config.bucket;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    assertValidPrivateKey(key);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          CacheControl: PRIVATE_CACHE_CONTROL,
          // Conditional write (R2 supports it): refuse instead of overwriting an existing proof.
          IfNoneMatch: "*",
        }),
      );
    } catch (error) {
      if (s3HttpStatus(error) !== 412) throw error;
      // 412 also happens when an earlier attempt of THIS put was stored but its response was lost
      // and the SDK retried. Same bytes already there = this upload succeeded.
      const existing = await this.get(key);
      if (existing && existing.equals(body)) return;
      throw new PrivateObjectExistsError(key);
    }
  }

  async get(key: string): Promise<Buffer | null> {
    assertValidPrivateKey(key);
    try {
      const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!response.Body) return null;
      return Buffer.from(await response.Body.transformToByteArray());
    } catch (error) {
      if (isS3NotFound(error)) return null;
      throw error;
    }
  }
}
