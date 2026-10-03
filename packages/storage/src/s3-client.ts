import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { StorageClient } from "./client";

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
    });
    this.bucket = config.bucket;
    this.publicBaseUrl = config.publicBaseUrl.replace(/\/+$/, "");
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  publicUrl(key: string): string {
    return `${this.publicBaseUrl}/${key}`;
  }
}
