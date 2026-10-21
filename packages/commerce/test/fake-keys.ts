// Fake provider keys for tests. Each is assembled at runtime from pieces, so no line of source
// ever contains a string shaped like a real Midtrans or Biteship key (secret scanners such as
// GitHub push protection match those shapes). The values still carry the real prefixes, so the
// code paths that read them (sandbox vs production key, test vs live key) are exercised.

const MIDTRANS_SERVER_PREFIX = ["Mid", "server", ""].join("-");

/** A fake Midtrans server key. Newer sandbox accounts and production both use the "Mid-server-"
 * prefix (only the default tag differs, so the two never collide); `legacy-sandbox` is an old-style
 * sandbox key with the "SB-" prefix, the only shape the config can still refuse in production. */
export function fakeMidtransServerKey(mode: "sandbox" | "legacy-sandbox" | "production", tag = mode === "production" ? "FAKEPROD" : "FAKESBX"): string {
  return `${mode === "legacy-sandbox" ? "SB-" : ""}${MIDTRANS_SERVER_PREFIX}${tag}${"0".repeat(20)}`;
}

/** A fake Biteship API key with the real mode prefix (`biteship_test.` / `biteship_live.`). */
export function fakeBiteshipKey(mode: "test" | "live", tag = "FAKE"): string {
  return [`biteship_${mode}`, `${tag}${"0".repeat(20)}`].join(".");
}
