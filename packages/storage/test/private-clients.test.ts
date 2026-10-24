import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { assertValidPrivateKey, PrivateObjectExistsError } from "../src/private-client";
import { FsPrivateStorageClient } from "../src/private-fs-client";
import { InMemoryPrivateStorageClient } from "../src/private-memory-client";
import { S3PrivateStorageClient } from "../src/private-s3-client";

const tempDirs: string[] = [];
function tempRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ammari-private-storage-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// The whole point of the private client (plan §5.3, P8): no code path can remove or expose a proof.
describe.each([
  ["InMemoryPrivateStorageClient", () => new InMemoryPrivateStorageClient()],
  ["FsPrivateStorageClient", () => new FsPrivateStorageClient(tempRoot())],
  [
    "S3PrivateStorageClient",
    () => new S3PrivateStorageClient({ endpoint: "https://s3.example.com", region: "auto", bucket: "b", accessKeyId: "k", secretAccessKey: "s" }),
  ],
])("%s surface", (_name, make) => {
  test("has no delete and no public URL", () => {
    const client = make() as unknown as Record<string, unknown>;
    expect(client.delete).toBeUndefined();
    expect(client.publicUrl).toBeUndefined();
    expect(typeof client.put).toBe("function");
    expect(typeof client.get).toBe("function");
  });
});

describe.each([
  ["InMemoryPrivateStorageClient", () => new InMemoryPrivateStorageClient()],
  ["FsPrivateStorageClient", () => new FsPrivateStorageClient(tempRoot())],
])("%s behaviour", (_name, make) => {
  test("put then get returns the same bytes; a missing key is null", async () => {
    const client = make();
    await client.put("local/payment_proof/2026/10/a.jpg", Buffer.from("proof"), "image/jpeg");
    expect(await client.get("local/payment_proof/2026/10/a.jpg")).toEqual(Buffer.from("proof"));
    expect(await client.get("local/payment_proof/2026/10/missing.jpg")).toBeNull();
  });

  test("is write-once: a second put to the same key is refused and the first bytes stay", async () => {
    const client = make();
    await client.put("k/a.pdf", Buffer.from("first"), "application/pdf");
    await expect(client.put("k/a.pdf", Buffer.from("second"), "application/pdf")).rejects.toBeInstanceOf(PrivateObjectExistsError);
    expect(await client.get("k/a.pdf")).toEqual(Buffer.from("first"));
  });

  test("refuses traversal and malformed keys on put and get", async () => {
    const client = make();
    for (const key of ["../escape.jpg", "a/../../escape.jpg", "/abs.jpg", "a//b.jpg", "a\\b.jpg", "", "a/./b.jpg"]) {
      await expect(client.put(key, Buffer.from("x"), "image/jpeg")).rejects.toThrow(/Invalid private storage key/);
      await expect(client.get(key)).rejects.toThrow(/Invalid private storage key/);
    }
  });
});

describe("FsPrivateStorageClient", () => {
  test("writes under its root directory with owner-only permissions", async () => {
    const root = tempRoot();
    const client = new FsPrivateStorageClient(root);
    await client.put("local/payment_proof/2026/10/a.jpg", Buffer.from("x"), "image/jpeg");
    expect(readdirSync(path.join(root, "local/payment_proof/2026/10"))).toEqual(["a.jpg"]);
    expect(statSync(path.join(root, "local/payment_proof/2026/10/a.jpg")).mode & 0o777).toBe(0o600);
  });
});

describe("assertValidPrivateKey", () => {
  test("accepts the keys this app builds", () => {
    expect(() => assertValidPrivateKey("dev/payment_proof/2026/10/0b6f3c2e-8e1a-4e8f-9a39-7f3a1c2d4e5f.jpg")).not.toThrow();
    expect(() => assertValidPrivateKey("purchase_invoice/2026/01/x.pdf")).not.toThrow();
  });

  test("rejects a key longer than 512 characters", () => {
    expect(() => assertValidPrivateKey("a".repeat(513))).toThrow(/Invalid private storage key/);
  });
});
