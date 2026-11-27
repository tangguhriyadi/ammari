import "server-only";

// A value that must never reach a log line, an error message, a JSON response or a template string
// (docs/plans/tiktok-shop-integration.md §7.1). Every implicit conversion prints `[redacted]`; the
// only way to the raw value is an explicit `reveal()`, which is easy to grep for.

const REDACTED = "[redacted]";

export class Secret<T extends string | Uint8Array = string> {
  readonly #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  /** The raw value. Call it only at the exact point of use (an HMAC key, a header value). */
  reveal(): T {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.toPrimitive](): string {
    return REDACTED;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return REDACTED;
  }
}
