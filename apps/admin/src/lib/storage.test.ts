import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { InMemoryStorageClient } from "@ammari/storage";
import { __setStorageClientForTests, getStorageClient, getStorageKeyPrefix } from "./storage";

const ENV_KEYS = [
  "STORAGE_DRIVER",
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_KEY_PREFIX",
  "STORAGE_PUBLIC_BASE_URL",
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  __setStorageClientForTests(undefined);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  __setStorageClientForTests(undefined);
  vi.unstubAllEnvs();
});

describe("getStorageClient", () => {
  test("returns the in-memory client when STORAGE_DRIVER=memory outside production", () => {
    process.env.STORAGE_DRIVER = "memory";
    vi.stubEnv("NODE_ENV", "test");
    expect(getStorageClient()).toBeInstanceOf(InMemoryStorageClient);
  });

  test("fails closed: refuses STORAGE_DRIVER=memory when NODE_ENV=production", () => {
    process.env.STORAGE_DRIVER = "memory";
    vi.stubEnv("NODE_ENV", "production");
    expect(() => getStorageClient()).toThrow(/not allowed when NODE_ENV=production/);
  });

  test("throws listing exactly which S3 env vars are missing, without STORAGE_DRIVER", () => {
    process.env.S3_ENDPOINT = "https://s3.example.com";
    process.env.S3_REGION = "id-west-1";
    // S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, STORAGE_PUBLIC_BASE_URL left unset.
    expect(() => getStorageClient()).toThrow(
      /S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, STORAGE_PUBLIC_BASE_URL/,
    );
  });

  test("builds a real S3 client once every required env var is set", () => {
    process.env.S3_ENDPOINT = "https://s3.example.com";
    process.env.S3_REGION = "id-west-1";
    process.env.S3_BUCKET = "ammari-products";
    process.env.S3_ACCESS_KEY_ID = "key";
    process.env.S3_SECRET_ACCESS_KEY = "secret";
    process.env.STORAGE_PUBLIC_BASE_URL = "https://cdn.example.com";
    expect(getStorageClient()).not.toBeInstanceOf(InMemoryStorageClient);
  });

  test("caches the client across calls instead of rebuilding it", () => {
    process.env.STORAGE_DRIVER = "memory";
    vi.stubEnv("NODE_ENV", "test");
    expect(getStorageClient()).toBe(getStorageClient());
  });
});

describe("getStorageKeyPrefix", () => {
  test("defaults to an empty string when unset", () => {
    expect(getStorageKeyPrefix()).toBe("");
  });

  test("returns the configured prefix", () => {
    process.env.S3_KEY_PREFIX = "dev/";
    expect(getStorageKeyPrefix()).toBe("dev/");
  });
});
