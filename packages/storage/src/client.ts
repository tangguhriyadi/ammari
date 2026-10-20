/** Minimal abstraction over an S3-compatible object store — just enough for product image
 * upload/delete and the public URL callers render `<img>` tags from. Deliberately NOT a general
 * S3 wrapper: no list/head/multipart, because nothing in this app needs them yet. `get` exists
 * for one server-side reader: the Hero's Open Graph JPEG, rendered at publish time from the
 * already-stored Hero image (apps/admin lib/content/hero-og-image.ts). */
export interface StorageClient {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** The object's bytes, or `null` when no object exists at `key`. Any other failure throws. */
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  publicUrl(key: string): string;
}
