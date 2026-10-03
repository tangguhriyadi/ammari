import { describe, expect, test, vi } from "vitest";

const sendMock = vi.fn().mockResolvedValue({});
const s3ClientConstructorArgs: unknown[] = [];

vi.mock("@aws-sdk/client-s3", () => {
  class FakeS3Client {
    constructor(args: unknown) {
      s3ClientConstructorArgs.push(args);
    }
    send = sendMock;
  }
  class FakeCommand {
    constructor(public input: unknown) {}
  }
  return {
    S3Client: FakeS3Client,
    PutObjectCommand: FakeCommand,
    DeleteObjectCommand: FakeCommand,
  };
});

const { S3StorageClient } = await import("../src/s3-client");

function baseConfig() {
  return {
    endpoint: "https://s3.example.com",
    region: "id-west-1",
    bucket: "ammari-products",
    accessKeyId: "key",
    secretAccessKey: "secret",
    publicBaseUrl: "https://cdn.example.com",
  };
}

describe("S3StorageClient", () => {
  test("always forces path-style addressing for the custom endpoint", () => {
    new S3StorageClient(baseConfig());
    const lastArgs = s3ClientConstructorArgs.at(-1) as { forcePathStyle: boolean };
    expect(lastArgs.forcePathStyle).toBe(true);
  });

  test("publicUrl joins the base URL and key with exactly one slash", () => {
    const client = new S3StorageClient(baseConfig());
    expect(client.publicUrl("products/a/400.webp")).toBe("https://cdn.example.com/products/a/400.webp");
  });

  test("publicUrl strips a trailing slash from the configured base URL", () => {
    const client = new S3StorageClient({ ...baseConfig(), publicBaseUrl: "https://cdn.example.com/" });
    expect(client.publicUrl("products/a/400.webp")).toBe("https://cdn.example.com/products/a/400.webp");
  });

  test("put sends a PutObjectCommand with the bucket, key, body and content type", async () => {
    const client = new S3StorageClient(baseConfig());
    await client.put("products/a/400.webp", Buffer.from("x"), "image/webp");
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { Bucket: "ammari-products", Key: "products/a/400.webp", Body: Buffer.from("x"), ContentType: "image/webp" },
      }),
    );
  });

  test("delete sends a DeleteObjectCommand with the bucket and key", async () => {
    const client = new S3StorageClient(baseConfig());
    await client.delete("products/a/400.webp");
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({ input: { Bucket: "ammari-products", Key: "products/a/400.webp" } }));
  });
});
