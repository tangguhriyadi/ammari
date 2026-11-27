import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Loads test/fixtures/official-vectors.json and the byte-exact official webhook body.

const dir = fileURLToPath(new URL("./fixtures/", import.meta.url));

export interface SignVector {
  name?: string;
  app_secret: string;
  method: "GET" | "POST";
  path: string;
  query: Record<string, string>;
  body?: string | null;
  string_to_sign: string;
  sign: string;
}

interface Vectors {
  official: {
    api_sign: SignVector;
    webhook: { app_key: string; app_secret: string; authorization: string; body_file: string; body_length: number; body_sha256: string };
  };
  own: {
    api_sign: SignVector[];
    webhook: { app_key: string; app_secret: string; body: string; authorization: string };
  };
}

export const vectors = JSON.parse(readFileSync(`${dir}official-vectors.json`, "utf8")) as Vectors;

/** The raw bytes of TikTok's example webhook, exactly as published (no trailing newline). */
export const officialWebhookBody: Buffer = readFileSync(`${dir}${vectors.official.webhook.body_file}`);
