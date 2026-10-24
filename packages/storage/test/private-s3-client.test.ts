import { beforeEach, describe, expect, test, vi } from "vitest";

// Mocked SDK: no real API call, no real bucket.
const sendMock = vi.fn();
const s3ClientConstructorArgs: unknown[] = [];

vi.mock("@aws-sdk/client-s3", () => {
  class FakeS3Client {
    constructor(args: unknown) {
      s3ClientConstructorArgs.push(args);
    }
    send = sendMock;
  }
  class FakePutObjectCommand {
    readonly kind = "put";
    constructor(public input: unknown) {}
  }
  class FakeGetObjectCommand {
    readonly kind = "get";
    constructor(public input: unknown) {}
  }
  class FakeCommand {
    constructor(public input: unknown) {}
  }
  class FakeNoSuchKey extends Error {}
  return {
    S3Client: FakeS3Client,
    PutObjectCommand: FakePutObjectCommand,
    GetObjectCommand: FakeGetObjectCommand,
    DeleteObjectCommand: FakeCommand,
    NoSuchKey: FakeNoSuchKey,
  };
});

const { S3PrivateStorageClient } = await import("../src/private-s3-client");
const { PrivateObjectExistsError } = await import("../src/private-client");

function makeClient() {
  return new S3PrivateStorageClient({
    endpoint: "https://acct.r2.cloudflarestorage.com",
    region: "auto",
    bucket: "ammari-dev-private",
    accessKeyId: "private-key",
    secretAccessKey: "private-secret",
  });
}

beforeEach(() => {
  sendMock.mockReset().mockResolvedValue({});
});

describe("S3PrivateStorageClient", () => {
  test("uses the shared S3 transport settings (path style, WHEN_REQUIRED checksums, 3 attempts) with its own credentials", () => {
    makeClient();
    expect(s3ClientConstructorArgs.at(-1)).toMatchObject({
      endpoint: "https://acct.r2.cloudflarestorage.com",
      region: "auto",
      forcePathStyle: true,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      maxAttempts: 3,
      credentials: { accessKeyId: "private-key", secretAccessKey: "private-secret" },
    });
  });

  test("put writes to the private bucket with Cache-Control private, no-store and a write-once condition", async () => {
    await makeClient().put("dev/payment_proof/2026/10/a.jpg", Buffer.from("x"), "image/jpeg");
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "put",
        input: {
          Bucket: "ammari-dev-private",
          Key: "dev/payment_proof/2026/10/a.jpg",
          Body: Buffer.from("x"),
          ContentType: "image/jpeg",
          CacheControl: "private, no-store",
          IfNoneMatch: "*",
        },
      }),
    );
  });

  test("put never sends the media bucket's public immutable cache header", async () => {
    await makeClient().put("k/a.pdf", Buffer.from("x"), "application/pdf");
    const input = (sendMock.mock.calls[0]![0] as { input: { CacheControl: string } }).input;
    expect(input.CacheControl).not.toMatch(/public/);
  });

  test("a 412 on put with DIFFERENT bytes already there becomes PrivateObjectExistsError; other errors pass through", async () => {
    sendMock.mockRejectedValueOnce(Object.assign(new Error("PreconditionFailed"), { $metadata: { httpStatusCode: 412 } }));
    sendMock.mockResolvedValueOnce({ Body: { transformToByteArray: async () => new Uint8Array([9]) } });
    await expect(makeClient().put("k/a.jpg", Buffer.from("x"), "image/jpeg")).rejects.toBeInstanceOf(PrivateObjectExistsError);
    sendMock.mockRejectedValueOnce(Object.assign(new Error("Forbidden"), { $metadata: { httpStatusCode: 403 } }));
    await expect(makeClient().put("k/b.jpg", Buffer.from("x"), "image/jpeg")).rejects.toThrow("Forbidden");
  });

  test("a 412 caused by a retried put whose first attempt was stored (same bytes there) is a success", async () => {
    sendMock.mockRejectedValueOnce(Object.assign(new Error("PreconditionFailed"), { $metadata: { httpStatusCode: 412 } }));
    sendMock.mockResolvedValueOnce({ Body: { transformToByteArray: async () => new Uint8Array(Buffer.from("x")) } });
    await expect(makeClient().put("k/a.jpg", Buffer.from("x"), "image/jpeg")).resolves.toBeUndefined();
  });

  test("get returns the bytes, null for a missing object, and rethrows anything else", async () => {
    const client = makeClient();
    sendMock.mockResolvedValueOnce({ Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) } });
    expect(await client.get("k/a.jpg")).toEqual(Buffer.from([1, 2, 3]));
    expect(sendMock).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "get", input: { Bucket: "ammari-dev-private", Key: "k/a.jpg" } }));

    sendMock.mockRejectedValueOnce(Object.assign(new Error("Not Found"), { $metadata: { httpStatusCode: 404 } }));
    expect(await client.get("k/missing.jpg")).toBeNull();

    sendMock.mockRejectedValueOnce(Object.assign(new Error("Forbidden"), { $metadata: { httpStatusCode: 403 } }));
    await expect(client.get("k/forbidden.jpg")).rejects.toThrow("Forbidden");
  });

  test("validates keys before any request", async () => {
    await expect(makeClient().put("../x.jpg", Buffer.from("x"), "image/jpeg")).rejects.toThrow(/Invalid private storage key/);
    expect(sendMock).not.toHaveBeenCalled();
  });
});
