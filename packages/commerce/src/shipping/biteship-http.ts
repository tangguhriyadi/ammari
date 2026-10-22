// Small helpers shared by the Biteship rate client (./biteship.ts) and order client
// (./biteship-orders.ts).

/** `path` under the configured base URL, with or without its trailing slash. */
export function joinUrl(baseUrl: string, path: string): URL {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(path, base);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A fetch failure caused by our own `AbortSignal.timeout` (or an abort). */
export function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}
