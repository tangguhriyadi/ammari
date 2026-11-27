import "server-only";

// A request body read as text up to a cap, incrementally, so a huge body is never buffered whole
// (the courier webhook, the TikTok webhook; the payment notification route has its own copy with its
// own logging). `raw` is the exact bytes received, for a signature computed over them (TikTok).

export type CappedBody = { ok: true; text: string; bytes: number; raw: Buffer } | { ok: false; reason: "too_large" | "unreadable"; bytesRead: number };

/** `timeoutMs`: give up (`unreadable`) when the whole body has not arrived by then, so a slow-drip
 * sender cannot hold the request open (the TikTok webhook must answer within 3 seconds). */
export async function readCappedBody(request: Request, maxBytes: number, options: { timeoutMs?: number } = {}): Promise<CappedBody> {
  const header = request.headers.get("content-length");
  const declared = header === null ? null : Number(header);
  if (declared !== null && Number.isFinite(declared) && declared > maxBytes) return { ok: false, reason: "too_large", bytesRead: 0 };
  if (!request.body) return { ok: true, text: "", bytes: 0, raw: Buffer.alloc(0) };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timedOut = false;
  const timer =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          reader.cancel().catch(() => undefined);
        }, options.timeoutMs);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (timedOut) return { ok: false, reason: "unreadable", bytesRead: size };
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
  } finally {
    clearTimeout(timer);
  }
  const raw = Buffer.concat(chunks);
  return { ok: true, text: new TextDecoder("utf-8", { fatal: false }).decode(raw), bytes: size, raw };
}
