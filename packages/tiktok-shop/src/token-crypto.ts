import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Secret } from "./secret";

// Access/refresh tokens at rest (docs/plans/tiktok-shop-integration.md §7.2): AES-256-GCM, a fresh
// random 12-byte IV per encryption, stored as `version byte | iv | ciphertext | tag`. The AAD binds
// a ciphertext to its row and column (connection id + column name) and to its version byte, so a
// value copied to another row, another column, or re-labelled with another key version fails to
// decrypt. Decryption fails closed with one error type; the caller maps it to `reauth_required`.

export const TOKEN_KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MIN_VERSION = 1;
const MAX_VERSION = 255;

/** The two encrypted columns of `tiktok_shop_connections`. */
export type TokenColumn = "access_token_ct" | "refresh_token_ct";

export interface TokenAad {
  connectionId: string;
  column: TokenColumn;
}

export interface TokenKeyring {
  /** The version new values are encrypted with (`TIKTOK_TOKEN_ENC_KEY_CURRENT`). */
  currentVersion: number;
  /** Every key still accepted for decryption, by version (`TIKTOK_TOKEN_ENC_KEY_V<n>`). */
  keys: ReadonlyMap<number, Secret<Uint8Array>>;
}

/** Why decryption failed, for the caller's error code. Never carries key or token material. */
export type TokenDecryptFailure = "malformed" | "unknown_key_version" | "authentication_failed";

export class TokenDecryptError extends Error {
  readonly reason: TokenDecryptFailure;

  constructor(reason: TokenDecryptFailure) {
    super(`token decrypt failed: ${reason}`);
    this.name = "TokenDecryptError";
    this.reason = reason;
  }
}

function isValidVersion(version: number): boolean {
  return Number.isInteger(version) && version >= MIN_VERSION && version <= MAX_VERSION;
}

function aadBytes(version: number, { connectionId, column }: TokenAad): Buffer {
  if (connectionId.length === 0 || connectionId.includes("\0")) throw new Error("token aad: invalid connection id");
  // A NUL separator keeps (id, column) pairs unambiguous whatever the id's length.
  return Buffer.concat([Buffer.from([version]), Buffer.from(`${connectionId}\0${column}`, "utf8")]);
}

function keyFor(keyring: TokenKeyring, version: number): Uint8Array | null {
  const key = keyring.keys.get(version)?.reveal();
  return key && key.length === TOKEN_KEY_BYTES ? key : null;
}

export function encryptToken(plaintext: Secret, keyring: TokenKeyring, aad: TokenAad): Buffer {
  // decryptToken refuses a value without ciphertext, so an empty token would never come back.
  if (plaintext.reveal().length === 0) throw new Error("token encrypt: empty token");
  const version = keyring.currentVersion;
  if (!isValidVersion(version)) throw new Error("token encrypt: invalid key version");
  const key = keyFor(keyring, version);
  if (!key) throw new Error("token encrypt: current key version has no valid key");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aadBytes(version, aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext.reveal(), "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([version]), iv, ciphertext, cipher.getAuthTag()]);
}

export function decryptToken(stored: Uint8Array, keyring: TokenKeyring, aad: TokenAad): Secret {
  // At least one byte of ciphertext: an empty token is never stored.
  if (stored.length < 1 + IV_BYTES + 1 + TAG_BYTES) throw new TokenDecryptError("malformed");
  const version = stored[0]!;
  if (!isValidVersion(version)) throw new TokenDecryptError("malformed");
  const key = keyFor(keyring, version);
  if (!key) throw new TokenDecryptError("unknown_key_version");
  const iv = stored.subarray(1, 1 + IV_BYTES);
  const tag = stored.subarray(stored.length - TAG_BYTES);
  const ciphertext = stored.subarray(1 + IV_BYTES, stored.length - TAG_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(aadBytes(version, aad));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return new Secret(plaintext.toString("utf8"));
  } catch {
    throw new TokenDecryptError("authentication_failed");
  }
}

/** The key version a stored value was encrypted with, so a rotation job can find rows still on an
 * old key (`token_key_version` should agree; this reads it from the value itself). */
export function tokenKeyVersion(stored: Uint8Array): number | null {
  const version = stored[0];
  return version !== undefined && isValidVersion(version) ? version : null;
}
