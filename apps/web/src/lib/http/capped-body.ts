import "server-only";

// A request body read as text up to a cap, incrementally, so a huge body is never buffered whole
// (the courier webhook; the payment notification route has its own copy with its own logging).

export type CappedBody = { ok: true; text: string; bytes: number } | { ok: false; reason: "too_large" | "unreadable"; bytesRead: number };

export async function readCappedBody(request: Request, maxBytes: number): Promise<CappedBody> {
  const header = request.headers.get("content-length");
  const declared = header === null ? null : Number(header);
  if (declared !== null && Number.isFinite(declared) && declared > maxBytes) return { ok: false, reason: "too_large", bytesRead: 0 };
  if (!request.body) return { ok: true, text: "", bytes: 0 };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return { ok: false, reason: "too_large", bytesRead: size };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "unreadable", bytesRead: size };
  }
  return { ok: true, text: new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks)), bytes: size };
}
