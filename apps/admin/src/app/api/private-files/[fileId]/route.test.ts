import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { InMemoryPrivateStorageClient, PrivateStorageConfigError } from "@ammari/storage";
import type { PermissionKey } from "@ammari/db/rbac";
import type { ServablePrivateFile } from "@/lib/supplier-payments/private-files";

const getStaffSession = vi.fn();
const findServablePrivateFile = vi.fn();

vi.mock("@/lib/auth/staff-session", () => ({ getStaffSession: () => getStaffSession() }));
vi.mock("@/lib/db", () => ({ defaultDb: {} }));
vi.mock("@/lib/supplier-payments/private-files", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/supplier-payments/private-files")>();
  return { ...actual, findServablePrivateFile: (...args: unknown[]) => findServablePrivateFile(...args) };
});

const { GET } = await import("./route");
const { __setPrivateStorageClientForTests } = await import("@/lib/private-storage");

const FILE_ID = "0b6f3c2e-8e1a-4e8f-9a39-7f3a1c2d4e5f";
const BODY = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

let storage: InMemoryPrivateStorageClient;

function session(permissionKeys: PermissionKey[]) {
  return { staffUser: { id: "staff-1" }, role: { id: "r", key: "owner", name: "Owner" }, permissionKeys };
}

function proof(overrides: Partial<ServablePrivateFile> = {}): ServablePrivateFile {
  return {
    id: FILE_ID,
    purpose: "payment_proof",
    storageKey: `test/payment_proof/2026/10/${FILE_ID}.jpg`,
    contentType: "image/jpeg",
    byteSize: BODY.length,
    sha256: createHash("sha256").update(BODY).digest("hex"),
    downloadName: "BYR-202610-001.jpg",
    ...overrides,
  };
}

async function get(fileId = FILE_ID): Promise<Response> {
  return GET(new Request(`http://localhost:3001/api/private-files/${fileId}`), { params: Promise.resolve({ fileId }) } as never);
}

const PROOF_KEYS: PermissionKey[] = ["supplier_payments.manage", "finance.view_profit"];

beforeEach(async () => {
  getStaffSession.mockReset();
  findServablePrivateFile.mockReset().mockResolvedValue(proof());
  storage = new InMemoryPrivateStorageClient();
  await storage.put(proof().storageKey, BODY, "image/jpeg");
  __setPrivateStorageClientForTests(storage);
});

afterEach(() => {
  __setPrivateStorageClientForTests(undefined);
  vi.restoreAllMocks();
});

describe("GET /api/private-files/[fileId]: access", () => {
  test("401 without a staff session, before any lookup", async () => {
    getStaffSession.mockResolvedValue(null);
    const response = await get();
    expect(response.status).toBe(401);
    expect(findServablePrivateFile).not.toHaveBeenCalled();
  });

  test("403 without finance.view_profit, before any lookup", async () => {
    getStaffSession.mockResolvedValue(session(["supplier_payments.manage", "inventory.view"]));
    const response = await get();
    expect(response.status).toBe(403);
    expect(findServablePrivateFile).not.toHaveBeenCalled();
  });

  test("403 for a payment proof without supplier_payments.manage (finance alone is not enough)", async () => {
    getStaffSession.mockResolvedValue(session(["finance.view_profit", "inventory.view", "inventory.manage"]));
    const response = await get();
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain(String.fromCharCode(0xff));
  });

  test("403 for a nota without inventory.view", async () => {
    findServablePrivateFile.mockResolvedValue(proof({ purpose: "purchase_invoice", downloadName: "PO-202610-001-nota.jpg" }));
    getStaffSession.mockResolvedValue(session(["finance.view_profit", "supplier_payments.manage"]));
    expect((await get()).status).toBe(403);
  });

  test("404 for an unknown, unreferenced or malformed id", async () => {
    getStaffSession.mockResolvedValue(session(PROOF_KEYS));
    findServablePrivateFile.mockResolvedValue(null);
    expect((await get("not-a-uuid")).status).toBe(404);
    expect(findServablePrivateFile).toHaveBeenCalledWith({}, "not-a-uuid");
  });

  test("denial responses are never cacheable and carry nosniff", async () => {
    getStaffSession.mockResolvedValue(null);
    const response = await get();
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("GET /api/private-files/[fileId]: serving", () => {
  test("200 for a proof with both keys: the stored bytes and safe headers", async () => {
    getStaffSession.mockResolvedValue(session(PROOF_KEYS));
    const response = await get();
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).equals(BODY)).toBe(true);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("content-length")).toBe(String(BODY.length));
    expect(response.headers.get("content-disposition")).toBe('inline; filename="BYR-202610-001.jpg"');
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });

  test("a PDF is served as application/pdf, inline, with a framing-only CSP", async () => {
    const pdf = Buffer.from("%PDF-1.7\n%%EOF\n");
    const file = proof({
      storageKey: `test/payment_proof/2026/10/${FILE_ID}.pdf`,
      contentType: "application/pdf",
      byteSize: pdf.length,
      sha256: createHash("sha256").update(pdf).digest("hex"),
      downloadName: "BYR-202610-002.pdf",
    });
    await storage.put(file.storageKey, pdf, "application/pdf");
    findServablePrivateFile.mockResolvedValue(file);
    getStaffSession.mockResolvedValue(session(PROOF_KEYS));

    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toBe('inline; filename="BYR-202610-002.pdf"');
    expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
    expect(Buffer.from(await response.arrayBuffer()).equals(pdf)).toBe(true);
  });

  test("a nota is served with inventory.view + finance.view_profit", async () => {
    findServablePrivateFile.mockResolvedValue(proof({ purpose: "purchase_invoice", downloadName: "PO-202610-001-nota.jpg" }));
    getStaffSession.mockResolvedValue(session(["inventory.view", "finance.view_profit"]));
    expect((await get()).status).toBe(200);
  });

  test("500 (logged) when a referenced object is missing from storage", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    findServablePrivateFile.mockResolvedValue(proof({ storageKey: "test/payment_proof/2026/10/gone.jpg" }));
    getStaffSession.mockResolvedValue(session(PROOF_KEYS));
    expect((await get()).status).toBe(500);
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("object missing"));
  });

  test("500 (logged) and no bytes when the stored object does not match its checksum", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    findServablePrivateFile.mockResolvedValue(proof({ sha256: "0".repeat(64) }));
    getStaffSession.mockResolvedValue(session(PROOF_KEYS));
    const response = await get();
    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("checksum mismatch"));
  });

  test("502 (logged with the file id, not the raw error object) when the storage read fails", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    __setPrivateStorageClientForTests({
      put: async () => {},
      get: async () => {
        throw new Error("socket hang up");
      },
    });
    getStaffSession.mockResolvedValue(session(PROOF_KEYS));
    const response = await get();
    expect(response.status).toBe(502);
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining(`private_files.id=${FILE_ID}: socket hang up`));
  });

  test("503 with the Indonesian message when private storage is not configured", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    __setPrivateStorageClientForTests({
      put: async () => {},
      get: async () => {
        throw new PrivateStorageConfigError("Missing required env var(s) for private file storage: PRIVATE_S3_BUCKET.");
      },
    });
    getStaffSession.mockResolvedValue(session(PROOF_KEYS));
    const response = await get();
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("Penyimpanan bukti belum dikonfigurasi.");
  });
});
