import type { StorageClient } from "./client";

// 1x1 transparent PNG, base64-encoded — see publicUrl()'s doc comment.
const EMPTY_PIXEL_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

/** In-process fake for unit/integration tests and e2e — no network, no real bucket. Objects are
 * exposed on `.objects` so tests can assert exactly what was written/removed. */
export class InMemoryStorageClient implements StorageClient {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    this.objects.set(key, { body, contentType });
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  /** A `data:` URL, not `memory://` — the latter isn't a scheme any browser can actually fetch,
   * which only ever showed up as a broken `<img>` once this client started being used for real
   * e2e/visual rendering (not just server-side assertions on `.objects`). Returns a 1x1
   * transparent-PNG data URL for a key that was never PUT (or already deleted) — an empty
   * string would be an invalid `src` and some browsers still issue a request for it. */
  publicUrl(key: string): string {
    const object = this.objects.get(key);
    if (!object) return EMPTY_PIXEL_DATA_URL;
    return `data:${object.contentType};base64,${object.body.toString("base64")}`;
  }
}
