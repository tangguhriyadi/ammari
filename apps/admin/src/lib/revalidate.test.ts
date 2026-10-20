import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { __resetWebInternalUrlForTests } from "./web-internal-url";

let savedWebInternalUrl: string | undefined;
let savedSecret: string | undefined;

beforeEach(() => {
  savedWebInternalUrl = process.env.WEB_INTERNAL_URL;
  savedSecret = process.env.REVALIDATE_SECRET;
  process.env.WEB_INTERNAL_URL = "http://web:3000";
  process.env.REVALIDATE_SECRET = "test-secret";
  __resetWebInternalUrlForTests();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  if (savedWebInternalUrl === undefined) delete process.env.WEB_INTERNAL_URL;
  else process.env.WEB_INTERNAL_URL = savedWebInternalUrl;
  if (savedSecret === undefined) delete process.env.REVALIDATE_SECRET;
  else process.env.REVALIDATE_SECRET = savedSecret;
  __resetWebInternalUrlForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("revalidateHomepage / revalidateProductSlug", () => {
  test("posts the expected URL, secret header, and paths; resolves ok:true on a 200", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { revalidateHomepage } = await import("./revalidate");
    const result = await revalidateHomepage();

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://web:3000/api/revalidate");
    expect(init.method).toBe("POST");
    expect(init.headers["x-revalidate-secret"]).toBe("test-secret");
    expect(JSON.parse(init.body)).toEqual({ tags: ["storefront:homepage"] });
  });

  test("revalidateProductSlug posts the product's slug path AND the homepage cache tag", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { revalidateProductSlug } = await import("./revalidate");
    const result = await revalidateProductSlug("gamis-basic");

    expect(result).toEqual({ ok: true });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init.body)).toEqual({ paths: ["/products/gamis-basic"], tags: ["storefront:homepage"] });
  });

  test("resolves ok:false (never throws) when apps/web responds with a non-2xx status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
    const { revalidateHomepage } = await import("./revalidate");
    await expect(revalidateHomepage()).resolves.toEqual({ ok: false });
  });

  test("resolves ok:false (never throws) when the network request itself rejects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const { revalidateHomepage } = await import("./revalidate");
    await expect(revalidateHomepage()).resolves.toEqual({ ok: false });
  });

  test("resolves ok:false (never throws) when REVALIDATE_SECRET is unset, without calling fetch", async () => {
    delete process.env.REVALIDATE_SECRET;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { revalidateHomepage } = await import("./revalidate");
    await expect(revalidateHomepage()).resolves.toEqual({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("revalidateProductSlugs", () => {
  test("deduplicates, posts every product path plus the homepage tag once, and batches by 10 paths", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { revalidateProductSlugs } = await import("./revalidate");

    const slugs = Array.from({ length: 12 }, (_, i) => `produk-${i}`);
    const result = await revalidateProductSlugs([...slugs, "produk-0", "produk-1"]);

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).paths).toHaveLength(10);
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual({ paths: ["/products/produk-10", "/products/produk-11"], tags: ["storefront:homepage"] });
  });

  test("makes no request for an empty list, and reports ok:false (never throws) if a batch fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const { revalidateProductSlugs } = await import("./revalidate");

    await expect(revalidateProductSlugs([])).resolves.toEqual({ ok: true });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(revalidateProductSlugs(["a"])).resolves.toEqual({ ok: false });
  });
});

describe("revalidateProductSlugs path cap", () => {
  test("exactly 10 products fit one request; 11 need two (apps/web accepts at most 10 paths)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { revalidateProductSlugs } = await import("./revalidate");
    await revalidateProductSlugs(Array.from({ length: 10 }, (_, i) => `p-${i}`));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await revalidateProductSlugs(Array.from({ length: 11 }, (_, i) => `q-${i}`));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
