import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { InMemoryPrivateStorageClient, PrivateStorageConfigError } from "@ammari/storage";
import { __setPrivateStorageClientForTests, getPrivateStorageClient } from "./private-storage";

const ENV_KEYS = [
  "PRIVATE_STORAGE_DRIVER",
  "PRIVATE_S3_BUCKET",
  "PRIVATE_S3_ACCESS_KEY_ID",
  "PRIVATE_S3_SECRET_ACCESS_KEY",
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  __setPrivateStorageClientForTests(undefined);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  __setPrivateStorageClientForTests(undefined);
  vi.unstubAllEnvs();
});

describe("getPrivateStorageClient", () => {
  test("memory driver outside production, cached across calls", () => {
    process.env.PRIVATE_STORAGE_DRIVER = "memory";
    vi.stubEnv("NODE_ENV", "test");
    const client = getPrivateStorageClient();
    expect(client).toBeInstanceOf(InMemoryPrivateStorageClient);
    expect(getPrivateStorageClient()).toBe(client);
  });

  test("fails closed in production with the memory driver", () => {
    process.env.PRIVATE_STORAGE_DRIVER = "memory";
    vi.stubEnv("NODE_ENV", "production");
    expect(() => getPrivateStorageClient()).toThrow(PrivateStorageConfigError);
  });

  test("throws, naming the missing vars, when the media S3 vars are set but the private ones are not", () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.S3_ENDPOINT = "https://s3.example.com";
    process.env.S3_REGION = "auto";
    process.env.S3_BUCKET = "ammari-prod";
    process.env.S3_ACCESS_KEY_ID = "media";
    expect(() => getPrivateStorageClient()).toThrow(/PRIVATE_S3_BUCKET, PRIVATE_S3_ACCESS_KEY_ID, PRIVATE_S3_SECRET_ACCESS_KEY/);
  });
});
