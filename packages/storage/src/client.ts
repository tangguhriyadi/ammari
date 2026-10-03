/** Minimal abstraction over an S3-compatible object store — just enough for product image
 * upload/delete and the public URL callers render `<img>` tags from. Deliberately NOT a general
 * S3 wrapper: no list/head/multipart, because nothing in this app needs them yet. */
export interface StorageClient {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
  publicUrl(key: string): string;
}
