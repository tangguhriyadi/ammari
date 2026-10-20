import { describe, expect, test, vi } from "vitest";

const sendMock = vi.fn().mockResolvedValue({});
const s3ClientConstructorArgs: unknown[] = [];
const nodeHttpHandlerConstructorArgs: unknown[] = [];

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
  class FakeNoSuchKey extends Error {}
  return {
    S3Client: FakeS3Client,
    PutObjectCommand: FakeCommand,
    GetObjectCommand: FakeCommand,
    DeleteObjectCommand: FakeCommand,
    NoSuchKey: FakeNoSuchKey,
  };
});

// A real NodeHttpHandler instance is a fine value to pass through untouched (S3StorageClient
// never calls into it directly, just hands it to the FakeS3Client above) — only the CONSTRUCTOR
// args matter here, which is what this records.
vi.mock("@smithy/node-http-handler", () => {
  class FakeNodeHttpHandler {
    constructor(args: unknown) {
      nodeHttpHandlerConstructorArgs.push(args);
    }
  }
  return { NodeHttpHandler: FakeNodeHttpHandler };
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

  // Regression coverage for the Cloudeka stall (a 7.6KB PUT took 113s instead of failing) — the
  // AWS SDK's flexible-checksum default (a CRC32 trailer some S3-compatible providers mishandle)
  // plus no request-level timeout combined to hang instead of erroring. See this file's own doc
  // comment in s3-client.ts for the full story.
  test("requests WHEN_REQUIRED checksum calculation/validation, not the SDK's WHEN_SUPPORTED default", () => {
    new S3StorageClient(baseConfig());
    const lastArgs = s3ClientConstructorArgs.at(-1) as {
      requestChecksumCalculation: string;
      responseChecksumValidation: string;
    };
    expect(lastArgs.requestChecksumCalculation).toBe("WHEN_REQUIRED");
    expect(lastArgs.responseChecksumValidation).toBe("WHEN_REQUIRED");
  });

  test("caps retries at 3 attempts", () => {
    new S3StorageClient(baseConfig());
    const lastArgs = s3ClientConstructorArgs.at(-1) as { maxAttempts: number };
    expect(lastArgs.maxAttempts).toBe(3);
  });

  test("uses a NodeHttpHandler with a short connect timeout and a bounded request timeout, so a stalled request fails fast instead of hanging", () => {
    new S3StorageClient(baseConfig());
    expect(s3ClientConstructorArgs.at(-1)).toMatchObject({ requestHandler: expect.anything() });
    const lastHandlerArgs = nodeHttpHandlerConstructorArgs.at(-1) as { connectionTimeout: number; requestTimeout: number };
    expect(lastHandlerArgs.connectionTimeout).toBe(5_000);
    expect(lastHandlerArgs.requestTimeout).toBe(30_000);
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
        input: {
          Bucket: "ammari-products",
          Key: "products/a/400.webp",
          Body: Buffer.from("x"),
          ContentType: "image/webp",
          CacheControl: "public, max-age=31536000, immutable",
        },
      }),
    );
  });

  // Regression coverage for the "immutable cache header is only safe because every key is
  // write-once" invariant (docs/plans/storage-r2.md's "Decisions") — every put() call gets the
  // same long-lived, immutable Cache-Control, since the write-path audit confirmed no caller ever
  // reuses a key.
  test("put always sets a long-lived immutable Cache-Control", async () => {
    const client = new S3StorageClient(baseConfig());
    await client.put("content/a/800.webp", Buffer.from("y"), "image/webp");
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ CacheControl: "public, max-age=31536000, immutable" }) }),
    );
  });

  test("delete sends a DeleteObjectCommand with the bucket and key", async () => {
    const client = new S3StorageClient(baseConfig());
    await client.delete("products/a/400.webp");
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({ input: { Bucket: "ammari-products", Key: "products/a/400.webp" } }));
  });

  test("get sends a GetObjectCommand and returns the body bytes", async () => {
    const client = new S3StorageClient(baseConfig());
    sendMock.mockResolvedValueOnce({ Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) } });
    expect(await client.get("content/hero/a/1600.webp")).toEqual(Buffer.from([1, 2, 3]));
    expect(sendMock).toHaveBeenLastCalledWith(expect.objectContaining({ input: { Bucket: "ammari-products", Key: "content/hero/a/1600.webp" } }));
  });

  test("get returns null for a missing object (typed NoSuchKey or a bare 404), and rethrows anything else", async () => {
    const { NoSuchKey } = await import("@aws-sdk/client-s3");
    const client = new S3StorageClient(baseConfig());
    sendMock.mockRejectedValueOnce(new NoSuchKey({ message: "missing", $metadata: {} }));
    expect(await client.get("missing")).toBeNull();
    sendMock.mockRejectedValueOnce(Object.assign(new Error("Not Found"), { $metadata: { httpStatusCode: 404 } }));
    expect(await client.get("missing")).toBeNull();
    sendMock.mockRejectedValueOnce(Object.assign(new Error("Forbidden"), { $metadata: { httpStatusCode: 403 } }));
    await expect(client.get("forbidden")).rejects.toThrow("Forbidden");
  });
});
