import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertValidPrivateKey, PrivateObjectExistsError, type PrivateStorageClient } from "./private-client";

/** Local-development driver (PRIVATE_STORAGE_DRIVER=fs): objects are plain files under a git- and
 * docker-ignored folder (apps/admin/.private-storage/), so a developer needs no private-bucket
 * secret. Refused in production by the env resolver. The content type is not persisted: the
 * admin always serves the type recorded in private_files, never one read back from storage. */
export class FsPrivateStorageClient implements PrivateStorageClient {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
  }

  private pathFor(key: string): string {
    assertValidPrivateKey(key);
    const resolved = path.resolve(this.rootDir, key);
    // Defence in depth: the key pattern already rules out "..", absolute paths and backslashes.
    if (!resolved.startsWith(this.rootDir + path.sep)) {
      throw new Error(`Invalid private storage key: ${JSON.stringify(key)}`);
    }
    return resolved;
  }

  async put(key: string, body: Buffer, _contentType: string): Promise<void> {
    const filePath = this.pathFor(key);
    await mkdir(path.dirname(filePath), { recursive: true });
    try {
      // "wx": fail if the file exists, so a key is never overwritten.
      await writeFile(filePath, body, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new PrivateObjectExistsError(key);
      throw error;
    }
  }

  async get(key: string): Promise<Buffer | null> {
    const filePath = this.pathFor(key);
    try {
      return await readFile(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
}
