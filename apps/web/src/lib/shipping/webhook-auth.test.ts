import { randomBytes } from "node:crypto";
import { describe, expect, test } from "vitest";
import { authorizeWebhook, webhookSecretsFromEnv } from "./webhook-auth";

// docs/plans/cart-checkout.md §15 Phase K "Webhook vs polling" (K3): the courier webhook's path
// token and static header. Values built at runtime.

const token = randomBytes(32).toString("hex");
const secret = randomBytes(32).toString("base64url");
const env = { BITESHIP_WEBHOOK_PATH_TOKEN: token, BITESHIP_WEBHOOK_HEADER_NAME: "X-Ammari-Courier", BITESHIP_WEBHOOK_HEADER_SECRET: secret };

describe("webhookSecretsFromEnv", () => {
  test("all three set: the header name is matched case-insensitively", () => {
    expect(webhookSecretsFromEnv(env)).toEqual({ ok: true, secrets: { pathToken: token, headerName: "x-ammari-courier", headerSecret: secret } });
  });

  test("missing, short or unsafe values are refused by name only", () => {
    const result = webhookSecretsFromEnv({});
    expect(result.ok).toBe(false);
    expect(!result.ok && result.problems.map((problem) => problem.split(" ")[0])).toEqual(["BITESHIP_WEBHOOK_PATH_TOKEN", "BITESHIP_WEBHOOK_HEADER_NAME", "BITESHIP_WEBHOOK_HEADER_SECRET"]);
    for (const bad of [
      { BITESHIP_WEBHOOK_PATH_TOKEN: "short" },
      { BITESHIP_WEBHOOK_PATH_TOKEN: `${token.slice(0, 40)}/../x` },
      { BITESHIP_WEBHOOK_HEADER_NAME: "Authorization" },
      { BITESHIP_WEBHOOK_HEADER_NAME: "X-Forwarded-For" },
      { BITESHIP_WEBHOOK_HEADER_NAME: "CF-Connecting-IP" },
      { BITESHIP_WEBHOOK_HEADER_NAME: "X Ammari" },
      { BITESHIP_WEBHOOK_HEADER_SECRET: "too-short" },
      { BITESHIP_WEBHOOK_HEADER_SECRET: `${secret} with spaces` },
    ]) {
      const refused = webhookSecretsFromEnv({ ...env, ...bad });
      expect(refused.ok).toBe(false);
      expect(JSON.stringify(refused)).not.toContain(secret);
      expect(JSON.stringify(refused)).not.toContain(token);
    }
  });
});

describe("authorizeWebhook", () => {
  const okResult = webhookSecretsFromEnv(env) as { ok: true; secrets: Parameters<typeof authorizeWebhook>[0] };
  const secrets = okResult.secrets;
  test("needs both the path token and the header", () => {
    expect(authorizeWebhook(secrets, token, new Headers({ "x-ammari-courier": secret }))).toEqual({ ok: true });
    expect(authorizeWebhook(secrets, `${token}x`, new Headers({ "x-ammari-courier": secret }))).toEqual({ ok: false, failed: "bad_path" });
    expect(authorizeWebhook(secrets, token, new Headers({ "x-ammari-courier": `${secret}x` }))).toEqual({ ok: false, failed: "bad_header" });
    expect(authorizeWebhook(secrets, token, new Headers())).toEqual({ ok: false, failed: "missing_header" });
    expect(authorizeWebhook(secrets, token, new Headers({ "x-ammari-courier": "" }))).toEqual({ ok: false, failed: "missing_header" });
    expect(authorizeWebhook(secrets, "", new Headers({ "x-ammari-courier": secret }))).toEqual({ ok: false, failed: "bad_path" });
    // A wrong path never says anything about the header.
    expect(authorizeWebhook(secrets, "", new Headers())).toEqual({ ok: false, failed: "bad_path" });
  });

  test("the header name in any case, and the value's outer whitespace, as Biteship's form may send them", () => {
    expect(authorizeWebhook(secrets, token, new Headers({ "X-AMMARI-COURIER": secret }))).toEqual({ ok: true });
    expect(authorizeWebhook(secrets, token, new Headers({ "x-ammari-courier": ` ${secret}\t` }))).toEqual({ ok: true });
    // A secret pasted into the env file with a trailing newline still matches.
    const padded = (webhookSecretsFromEnv({ ...env, BITESHIP_WEBHOOK_HEADER_SECRET: `${secret}\n`, BITESHIP_WEBHOOK_PATH_TOKEN: `${token}\r\n` }) as typeof okResult).secrets;
    expect(authorizeWebhook(padded, token, new Headers({ "x-ammari-courier": secret }))).toEqual({ ok: true });
  });
});
