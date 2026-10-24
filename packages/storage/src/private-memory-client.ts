import { assertValidPrivateKey, PrivateObjectExistsError, type PrivateStorageClient } from "./private-client";

/** In-process fake for unit tests and e2e (PRIVATE_STORAGE_DRIVER=memory). Objects are exposed on
 * `.objects` so tests can assert exactly what was written. Same write-once rule as the real
 * drivers. */
export class InMemoryPrivateStorageClient implements PrivateStorageClient {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    assertValidPrivateKey(key);
    if (this.objects.has(key)) throw new PrivateObjectExistsError(key);
    this.objects.set(key, { body: Buffer.from(body), contentType });
  }

  async get(key: string): Promise<Buffer | null> {
    assertValidPrivateKey(key);
    const object = this.objects.get(key);
    return object ? Buffer.from(object.body) : null;
  }
}
