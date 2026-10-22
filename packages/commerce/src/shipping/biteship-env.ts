import { readDeployEnv } from "../deploy-env";

// The Biteship connection variables shared by the rate runtime (./config.ts, checkout) and the
// shipment runtime (./shipment-config.ts, Phase K bookings and tracking). Problems name variables,
// never values.

export type ShippingEnv = Readonly<Record<string, string | undefined>>;

/** The only host the Biteship key is ever sent to. */
export const BITESHIP_HOST = "api.biteship.com";

/** The fallback when unset, the number when it is plain digits above 0, otherwise null (a
 * problem). "1e3", "0x10" and "12.5" are refused. */
export function positiveInt(value: string | undefined, fallback: number): number | null {
  if (value === undefined || value.trim() === "") return fallback;
  const text = value.trim();
  if (!/^[0-9]{1,9}$/.test(text)) return null;
  const parsed = Number(text);
  return parsed > 0 ? parsed : null;
}

export interface BiteshipConnection {
  apiKey: string;
  baseUrl: string;
  originAreaId: string;
  isProductionDeploy: boolean;
}

export interface ReadBiteshipConnectionOptions {
  /** Bookings call real couriers with a live key: refuse a live key outside a production deploy
   * (rates only cost a few rupiah, so the rate runtime allows it). */
  liveKeyOnlyInProduction?: boolean;
}

/** `BITESHIP_API_KEY`, `BITESHIP_BASE_URL`, `BITESHIP_ORIGIN_AREA_ID` and `DEPLOY_ENV`. Pushes
 * every problem onto `problems` and returns the connection only when there was none. */
export function readBiteshipConnection(env: ShippingEnv, problems: string[], options: ReadBiteshipConnectionOptions = {}): BiteshipConnection | null {
  const before = problems.length;
  const apiKey = env.BITESHIP_API_KEY?.trim();
  const baseUrl = env.BITESHIP_BASE_URL?.trim();
  const originAreaId = env.BITESHIP_ORIGIN_AREA_ID?.trim();
  // An allowlist, failing closed like the payment guard: a typo never unlocks a test key in prod.
  const { isProductionDeploy, problem: deployEnvProblem } = readDeployEnv(env);
  if (deployEnvProblem) problems.push(deployEnvProblem);
  if (!apiKey) problems.push("BITESHIP_API_KEY is not set");
  else if (apiKey.startsWith("biteship_test.") && isProductionDeploy) {
    // Fails closed when a production build does not say which environment it is.
    problems.push("BITESHIP_API_KEY is a test key but DEPLOY_ENV is production or unset");
  } else if (options.liveKeyOnlyInProduction && !apiKey.startsWith("biteship_test.") && !isProductionDeploy) {
    // Anything but a test key counts as live here: an unknown shape must not book real pickups.
    problems.push("BITESHIP_API_KEY is not a test key but DEPLOY_ENV is not production (bookings would call real couriers)");
  }
  if (!baseUrl) problems.push("BITESHIP_BASE_URL is not set");
  else {
    let url: URL | null = null;
    try {
      url = new URL(baseUrl);
    } catch {
      url = null;
    }
    // The key travels in a header, so only Biteship's own host, over https, with nothing else in
    // the URL (no credentials, query, fragment or path: the clients append `v1/...` themselves).
    if (!url || url.protocol !== "https:" || url.hostname !== BITESHIP_HOST || url.port !== "" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      problems.push(`BITESHIP_BASE_URL must be https://${BITESHIP_HOST}`);
    }
  }
  if (!originAreaId) problems.push("BITESHIP_ORIGIN_AREA_ID is not set");
  if (problems.length > before || !apiKey || !baseUrl || !originAreaId) return null;
  return { apiKey, baseUrl, originAreaId, isProductionDeploy };
}
