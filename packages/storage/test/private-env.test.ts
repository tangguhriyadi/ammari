import { describe, expect, test } from "vitest";
import { PrivateStorageConfigError } from "../src/private-client";
import { createPrivateStorageClientFromEnv } from "../src/private-env";
import { FsPrivateStorageClient } from "../src/private-fs-client";
import { InMemoryPrivateStorageClient } from "../src/private-memory-client";
import { S3PrivateStorageClient } from "../src/private-s3-client";

const options = { fsRootDir: "/tmp/ammari-private-storage-test" };

function fullS3Env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    NODE_ENV: "production",
    S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
    S3_REGION: "auto",
    S3_BUCKET: "ammari-prod",
    S3_ACCESS_KEY_ID: "media-key",
    S3_SECRET_ACCESS_KEY: "media-secret",
    PRIVATE_S3_BUCKET: "ammari-prod-private",
    PRIVATE_S3_ACCESS_KEY_ID: "private-key",
    PRIVATE_S3_SECRET_ACCESS_KEY: "private-secret",
    ...overrides,
  };
}

describe("createPrivateStorageClientFromEnv", () => {
  test("memory driver outside production -> in-memory client", () => {
    expect(createPrivateStorageClientFromEnv({ NODE_ENV: "test", PRIVATE_STORAGE_DRIVER: "memory" }, options)).toBeInstanceOf(
      InMemoryPrivateStorageClient,
    );
  });

  test("fs driver outside production -> fs client", () => {
    expect(createPrivateStorageClientFromEnv({ NODE_ENV: "development", PRIVATE_STORAGE_DRIVER: "fs" }, options)).toBeInstanceOf(
      FsPrivateStorageClient,
    );
  });

  test.each([
    ["memory", "production"],
    ["fs", "production"],
    ["memory", undefined],
    ["fs", undefined],
    ["fs", "prod"],
  ])("refuses PRIVATE_STORAGE_DRIVER=%s when NODE_ENV=%s (fails closed: only development/test allow it)", (driver, nodeEnv) => {
    const env = { ...fullS3Env({ NODE_ENV: nodeEnv }), PRIVATE_STORAGE_DRIVER: driver };
    expect(() => createPrivateStorageClientFromEnv(env, options)).toThrow(PrivateStorageConfigError);
    expect(() => createPrivateStorageClientFromEnv(env, options)).toThrow(/only allowed when NODE_ENV is development or test/);
  });

  test("refuses an unknown driver instead of guessing", () => {
    expect(() => createPrivateStorageClientFromEnv({ NODE_ENV: "development", PRIVATE_STORAGE_DRIVER: "s4" }, options)).toThrow(
      /Unknown PRIVATE_STORAGE_DRIVER/,
    );
  });

  test("builds the S3 private client when every var is set", () => {
    expect(createPrivateStorageClientFromEnv(fullS3Env(), options)).toBeInstanceOf(S3PrivateStorageClient);
  });

  test("without the private config, refuses to run and never falls back to the media bucket, even though S3_* is set", () => {
    const env = fullS3Env({ PRIVATE_S3_BUCKET: undefined, PRIVATE_S3_ACCESS_KEY_ID: "", PRIVATE_S3_SECRET_ACCESS_KEY: "  " });
    expect(() => createPrivateStorageClientFromEnv(env, options)).toThrow(PrivateStorageConfigError);
    expect(() => createPrivateStorageClientFromEnv(env, options)).toThrow(
      /PRIVATE_S3_BUCKET, PRIVATE_S3_ACCESS_KEY_ID, PRIVATE_S3_SECRET_ACCESS_KEY/,
    );
  });

  test("outside production too: no driver and no config is an error, not a silent local fallback", () => {
    expect(() => createPrivateStorageClientFromEnv({ NODE_ENV: "development" }, options)).toThrow(
      /S3_ENDPOINT, S3_REGION, PRIVATE_S3_BUCKET, PRIVATE_S3_ACCESS_KEY_ID, PRIVATE_S3_SECRET_ACCESS_KEY/,
    );
  });

  test("refuses a bucket whose name does not end in -private (e.g. a media bucket)", () => {
    for (const bucket of ["ammari-prod", "ammari-dev", "ammari-private-media"]) {
      expect(() => createPrivateStorageClientFromEnv(fullS3Env({ PRIVATE_S3_BUCKET: bucket }), options)).toThrow(/ends in "-private"/);
    }
  });

  test("refuses the media bucket as the private bucket", () => {
    expect(() =>
      createPrivateStorageClientFromEnv(fullS3Env({ S3_BUCKET: "ammari-prod-private", PRIVATE_S3_BUCKET: "ammari-prod-private" }), options),
    ).toThrow(/must not be the media bucket/);
  });

  test("refuses the media secret as the private secret", () => {
    expect(() => createPrivateStorageClientFromEnv(fullS3Env({ PRIVATE_S3_SECRET_ACCESS_KEY: "media-secret" }), options)).toThrow(
      /must not be the media token/,
    );
  });

  test("refuses the media token as the private token", () => {
    expect(() => createPrivateStorageClientFromEnv(fullS3Env({ PRIVATE_S3_ACCESS_KEY_ID: "media-key" }), options)).toThrow(
      /must not be the media token/,
    );
  });

  test("never puts a credential value in the error message", () => {
    try {
      createPrivateStorageClientFromEnv(fullS3Env({ PRIVATE_S3_ACCESS_KEY_ID: "media-key" }), options);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain("media-key");
      expect((error as Error).message).not.toContain("private-secret");
    }
  });
});
