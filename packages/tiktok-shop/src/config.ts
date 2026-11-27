import "server-only";
import { Secret } from "./secret";
import { TOKEN_KEY_BYTES, type TokenKeyring } from "./token-crypto";

// TikTok Shop configuration from the environment (docs/plans/tiktok-shop-integration.md §2
// "Gating", §7.1). Validated once; any problem gives `{ configured: false, problems }` and the
// integration stays off (the cron answers 503 notConfigured, the webhook 503). Problems name
// variables only, never values, so they are safe to log. Secret values are wrapped in `Secret`.

export type TikTokEnv = Readonly<Record<string, string | undefined>>;

export interface TikTokConfig {
  appKey: Secret;
  appSecret: Secret;
  /** `TIKTOK_SERVICE_ID`, the Partner Center app ID (decided Q4), never the App Key. Only the admin
   * app needs it (authorize link); null when not requested and not set. */
  serviceId: string | null;
  tokenKeyring: TokenKeyring;
}

export type TikTokConfigResult = { configured: true; config: TikTokConfig } | { configured: false; problems: string[] };

export interface TikTokConfigOptions {
  /** The admin app builds the authorize link and needs `TIKTOK_SERVICE_ID`. */
  requireServiceId?: boolean;
}

// Printable ASCII without spaces. The exact shape of TikTok's key and secret is not documented in
// the facts this plan relies on, so only obvious paste mistakes (whitespace, quotes, empty) fail.
const CREDENTIAL_PATTERN = /^[\x21\x23-\x26\x28-\x7e]{1,256}$/;
const SERVICE_ID_PATTERN = /^[0-9]{1,32}$/;
const VERSION_PATTERN = /^[1-9][0-9]{0,2}$/;
const KEY_VAR_PATTERN = /^TIKTOK_TOKEN_ENC_KEY_V([1-9][0-9]{0,2})$/;
// Canonical base64 of 32 bytes: 43 characters + one "=".
const KEY_BASE64_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

function decodeKey(value: string): Uint8Array | null {
  if (!KEY_BASE64_PATTERN.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  // Round-trip check: refuses non-canonical padding bits.
  return bytes.length === TOKEN_KEY_BYTES && bytes.toString("base64") === value ? new Uint8Array(bytes) : null;
}

export function tiktokConfigFromEnv(env: TikTokEnv, options: TikTokConfigOptions = {}): TikTokConfigResult {
  const problems: string[] = [];

  const appKey = env.TIKTOK_APP_KEY;
  if (!appKey) problems.push("TIKTOK_APP_KEY is not set");
  else if (!CREDENTIAL_PATTERN.test(appKey)) problems.push("TIKTOK_APP_KEY has an invalid format");

  const appSecret = env.TIKTOK_APP_SECRET;
  if (!appSecret) problems.push("TIKTOK_APP_SECRET is not set");
  else if (!CREDENTIAL_PATTERN.test(appSecret)) problems.push("TIKTOK_APP_SECRET has an invalid format");

  const serviceIdValue = env.TIKTOK_SERVICE_ID;
  let serviceId: string | null = null;
  if (serviceIdValue) {
    if (!SERVICE_ID_PATTERN.test(serviceIdValue)) problems.push("TIKTOK_SERVICE_ID must be the numeric Partner Center app ID");
    else if (serviceIdValue === appKey) problems.push("TIKTOK_SERVICE_ID must be the Partner Center app ID, not the App Key");
    else serviceId = serviceIdValue;
  } else if (options.requireServiceId) {
    problems.push("TIKTOK_SERVICE_ID is not set");
  }

  const keys = new Map<number, Secret<Uint8Array>>();
  for (const [name, value] of Object.entries(env)) {
    const match = KEY_VAR_PATTERN.exec(name);
    if (!match || value === undefined || value === "") continue;
    const version = Number(match[1]);
    if (version > 255) {
      problems.push(`${name}: key versions go up to 255`);
      continue;
    }
    const key = decodeKey(value);
    if (!key) problems.push(`${name} must be 32 random bytes in base64`);
    else keys.set(version, new Secret(key));
  }

  const currentValue = env.TIKTOK_TOKEN_ENC_KEY_CURRENT;
  let currentVersion = 0;
  if (!currentValue) problems.push("TIKTOK_TOKEN_ENC_KEY_CURRENT is not set");
  else if (!VERSION_PATTERN.test(currentValue) || Number(currentValue) > 255) problems.push("TIKTOK_TOKEN_ENC_KEY_CURRENT must be a key version from 1 to 255");
  else {
    currentVersion = Number(currentValue);
    if (!keys.has(currentVersion) && !problems.some((problem) => problem.startsWith(`TIKTOK_TOKEN_ENC_KEY_V${currentVersion} `))) {
      problems.push(`TIKTOK_TOKEN_ENC_KEY_V${currentVersion} is not set (named by TIKTOK_TOKEN_ENC_KEY_CURRENT)`);
    }
  }

  if (problems.length > 0 || !appKey || !appSecret) return { configured: false, problems };
  return {
    configured: true,
    config: {
      appKey: new Secret(appKey),
      appSecret: new Secret(appSecret),
      serviceId,
      tokenKeyring: { currentVersion, keys },
    },
  };
}
