import { describe, expect, test } from "vitest";
import { InMemoryStorageClient } from "../src/memory-client";

describe("InMemoryStorageClient", () => {
  test("put stores the object, retrievable via .objects", async () => {
    const client = new InMemoryStorageClient();
    await client.put("a/b.webp", Buffer.from("hello"), "image/webp");
    expect(client.objects.get("a/b.webp")).toEqual({ body: Buffer.from("hello"), contentType: "image/webp" });
  });

  test("delete removes the object", async () => {
    const client = new InMemoryStorageClient();
    await client.put("a/b.webp", Buffer.from("hello"), "image/webp");
    await client.delete("a/b.webp");
    expect(client.objects.has("a/b.webp")).toBe(false);
  });

  test("delete of a missing key is a no-op", async () => {
    const client = new InMemoryStorageClient();
    await expect(client.delete("nope")).resolves.toBeUndefined();
  });

  test("publicUrl returns a renderable data: URL for an object that was put", async () => {
    const client = new InMemoryStorageClient();
    await client.put("a/b.webp", Buffer.from("hello"), "image/webp");
    expect(client.publicUrl("a/b.webp")).toBe(`data:image/webp;base64,${Buffer.from("hello").toString("base64")}`);
  });

  test("publicUrl returns a valid placeholder data: URL for a key that was never put", () => {
    const client = new InMemoryStorageClient();
    expect(client.publicUrl("nope")).toMatch(/^data:image\/png;base64,/);
  });
});
