import "server-only";
import {
  createTikTokAuthClient,
  createTikTokClient,
  tiktokConfigFromEnv,
  type FetchLike,
  type TikTokAuthClient,
  type TikTokClient,
  type TikTokConfig,
  type TikTokEnv,
} from "@ammari/tiktok-shop";
import { FAKE_TIKTOK_API_BASE_URL, FAKE_TIKTOK_AUTH_BASE_URL, createFakeTikTokFetch } from "./fake";

// Which TikTok Shop runs, from the environment (docs/plans/tiktok-shop-integration.md §2 "Gating",
// §7.1). Off unless every variable is present and valid; problems name variables, never values.
// `TIKTOK_PROVIDER=fake` swaps in the in-memory fake (./fake.ts), only in a non-production build
// with E2E_TEST_LOGIN=true, like PAYMENT_PROVIDER=fake: a deployed container can never use it.

export interface TikTokRuntime {
  config: TikTokConfig;
  auth: TikTokAuthClient;
  api: TikTokClient;
}

export type TikTokRuntimeResult = { ok: true; runtime: TikTokRuntime } | { ok: false; problems: string[] };

export interface TikTokRuntimeOptions {
  /** The admin app builds the authorize link (TIKTOK_SERVICE_ID). */
  requireServiceId?: boolean;
  /** Tests inject a fake HTTP layer. */
  fetch?: FetchLike;
  now?: () => number;
}

// Dummy e2e values: never a real credential. The key is 32 fixed bytes, base64.
const FAKE_ENV: TikTokEnv = {
  TIKTOK_APP_KEY: "e2efakeappkey",
  TIKTOK_APP_SECRET: "e2efakeappsecret",
  TIKTOK_SERVICE_ID: "7000000000000000000",
  TIKTOK_TOKEN_ENC_KEY_V1: Buffer.alloc(32, 0x2a).toString("base64"),
  TIKTOK_TOKEN_ENC_KEY_CURRENT: "1",
};

export function tiktokRuntimeFromEnv(env: TikTokEnv, options: TikTokRuntimeOptions = {}): TikTokRuntimeResult {
  const provider = env.TIKTOK_PROVIDER?.trim() || "tiktok";
  let fake = false;
  if (provider === "fake") {
    // Fails closed: NODE_ENV must say development or test explicitly (an unset NODE_ENV in a
    // deployed container never counts as non-production).
    if ((env.NODE_ENV !== "development" && env.NODE_ENV !== "test") || env.E2E_TEST_LOGIN !== "true") {
      return { ok: false, problems: ["TIKTOK_PROVIDER=fake is only allowed in e2e runs (NODE_ENV development or test, with E2E_TEST_LOGIN=true)"] };
    }
    fake = true;
  } else if (provider !== "tiktok") {
    return { ok: false, problems: ["TIKTOK_PROVIDER must be tiktok or fake"] };
  }

  const result = tiktokConfigFromEnv(fake ? FAKE_ENV : env, { requireServiceId: options.requireServiceId });
  if (!result.configured) return { ok: false, problems: result.problems };
  const { config } = result;
  const fetch = options.fetch ?? (fake ? createFakeTikTokFetch(options.now) : undefined);
  const shared = { appKey: config.appKey, appSecret: config.appSecret, fetch, now: options.now };
  return {
    ok: true,
    runtime: {
      config,
      auth: createTikTokAuthClient({ ...shared, baseUrl: fake ? FAKE_TIKTOK_AUTH_BASE_URL : undefined }),
      api: createTikTokClient({ ...shared, baseUrl: fake ? FAKE_TIKTOK_API_BASE_URL : undefined }),
    },
  };
}

