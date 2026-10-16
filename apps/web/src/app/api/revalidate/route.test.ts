import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

const { revalidatePath, revalidateTag } = await import("next/cache");
const { POST } = await import("./route");

const SECRET = "test-revalidate-secret";

function postRequest(body: unknown, headers: Record<string, string> = { "x-revalidate-secret": SECRET }): Request {
  return new Request("http://localhost/api/revalidate", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /api/revalidate", () => {
  let savedSecret: string | undefined;

  beforeEach(() => {
    savedSecret = process.env.REVALIDATE_SECRET;
    process.env.REVALIDATE_SECRET = SECRET;
    vi.mocked(revalidatePath).mockClear();
    vi.mocked(revalidateTag).mockClear();
  });

  afterEach(() => {
    if (savedSecret === undefined) delete process.env.REVALIDATE_SECRET;
    else process.env.REVALIDATE_SECRET = savedSecret;
  });

  test("rejects a missing secret header with 401, never calling revalidatePath", async () => {
    const response = await POST(postRequest({ paths: ["/"] }, {}));
    expect(response.status).toBe(401);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  test("rejects a wrong secret with 401", async () => {
    const response = await POST(postRequest({ paths: ["/"] }, { "x-revalidate-secret": "wrong" }));
    expect(response.status).toBe(401);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  test("rejects a malformed JSON body with 400", async () => {
    const request = new Request("http://localhost/api/revalidate", {
      method: "POST",
      headers: { "content-type": "application/json", "x-revalidate-secret": SECRET },
      body: "not json",
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  test("rejects a body without a valid paths array with 400", async () => {
    const response = await POST(postRequest({ paths: [] }));
    expect(response.status).toBe(400);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  test("rejects a path that doesn't start with /", async () => {
    const response = await POST(postRequest({ paths: ["products/x"] }));
    expect(response.status).toBe(400);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  test("rejects a body with neither paths nor tags with 400", async () => {
    const response = await POST(postRequest({}));
    expect(response.status).toBe(400);
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  test("revalidates every path and returns ok:true with the correct secret", async () => {
    const response = await POST(postRequest({ paths: ["/", "/products/gamis-basic"] }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ ok: true, revalidated: { paths: ["/", "/products/gamis-basic"], tags: [] } });
    expect(revalidatePath).toHaveBeenCalledWith("/");
    expect(revalidatePath).toHaveBeenCalledWith("/products/gamis-basic");
    expect(revalidatePath).toHaveBeenCalledTimes(2);
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  test("revalidates every tag (with the immediate-expiry profile) and returns ok:true", async () => {
    const response = await POST(postRequest({ tags: ["storefront:homepage"] }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ ok: true, revalidated: { paths: [], tags: ["storefront:homepage"] } });
    expect(revalidateTag).toHaveBeenCalledWith("storefront:homepage", { expire: 0 });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  test("accepts both paths and tags in the same request", async () => {
    const response = await POST(postRequest({ paths: ["/products/gamis-basic"], tags: ["storefront:homepage"] }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      ok: true,
      revalidated: { paths: ["/products/gamis-basic"], tags: ["storefront:homepage"] },
    });
    expect(revalidatePath).toHaveBeenCalledWith("/products/gamis-basic");
    expect(revalidateTag).toHaveBeenCalledWith("storefront:homepage", { expire: 0 });
  });
});
