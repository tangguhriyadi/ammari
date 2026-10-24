/** Storage for PRIVATE objects (supplier payment proofs, supplier notas; docs/plans/purchase-
 * payments.md §5). Deliberately narrower than StorageClient: there is no `delete` (a proof is
 * never removed by code, P8) and no `publicUrl` (a proof is only ever served through the admin's
 * permission-checked route, never by a link, A6). Keys are write-once: `put` refuses to overwrite
 * an existing object. */
export interface PrivateStorageClient {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** The object's bytes, or `null` when no object exists at `key`. Any other failure throws. */
  get(key: string): Promise<Buffer | null>;
}

/** Thrown when the private storage is not configured (missing env vars, or a config that would
 * put private files somewhere public). Callers turn it into "Penyimpanan bukti belum
 * dikonfigurasi." instead of storing the file anywhere else. */
export class PrivateStorageConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivateStorageConfigError";
  }
}

/** A `put` against a key that already holds an object. Keys embed a fresh uuid, so this only
 * ever means a bug; it is refused rather than overwriting a stored proof. */
export class PrivateObjectExistsError extends Error {
  constructor(key: string) {
    super(`Private object already exists at key "${key}"; private objects are write-once.`);
    this.name = "PrivateObjectExistsError";
  }
}

// Letters, digits, "-", "_", "." and "/" only; no leading "/", no empty, "." or ".." segment.
// Every key this app builds ({prefix}{purpose}/{yyyy}/{mm}/{uuid}.{ext}) fits, and the fs driver
// relies on it to stay inside its root directory.
const KEY_PATTERN = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/;
const MAX_KEY_LENGTH = 512;

export function assertValidPrivateKey(key: string): void {
  const valid =
    key.length > 0 &&
    key.length <= MAX_KEY_LENGTH &&
    KEY_PATTERN.test(key) &&
    key.split("/").every((segment) => segment !== "." && segment !== "..");
  if (!valid) throw new Error(`Invalid private storage key: ${JSON.stringify(key)}`);
}
