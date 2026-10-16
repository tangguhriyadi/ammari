import { describe, expect, test } from "vitest";
import {
  bucketNameFromPolicy,
  buildVerifyTargets,
  loadPolicyFile,
  parsePolicyArgs,
  policyFilePath,
  stripPolicyComments,
} from "../src/policy";

describe("parsePolicyArgs", () => {
  test("parses --env and --dry-run", () => {
    expect(parsePolicyArgs(["--env", "dev", "--dry-run"])).toEqual({ env: "dev", dryRun: true });
  });

  test("defaults dryRun to false", () => {
    expect(parsePolicyArgs(["--env", "prod"])).toEqual({ env: "prod", dryRun: false });
  });

  test("works regardless of flag order", () => {
    expect(parsePolicyArgs(["--dry-run", "--env", "dev"])).toEqual({ env: "dev", dryRun: true });
  });

  test("throws when --env is missing", () => {
    expect(() => parsePolicyArgs(["--dry-run"])).toThrow(/--env must be/);
  });

  test("throws when --env is not dev or prod", () => {
    expect(() => parsePolicyArgs(["--env", "staging"])).toThrow(/--env must be/);
  });
});

describe("stripPolicyComments", () => {
  test("drops top-level keys starting with underscore", () => {
    expect(stripPolicyComments({ _comment: "doc text", Version: "2012-10-17", Statement: [] })).toEqual({
      Version: "2012-10-17",
      Statement: [],
    });
  });

  test("is a no-op when there is nothing to strip", () => {
    const policy = { Version: "2012-10-17", Statement: [] };
    expect(stripPolicyComments(policy)).toEqual(policy);
  });
});

describe("bucketNameFromPolicy", () => {
  test("extracts the bucket name from a single-resource statement", () => {
    const policy = {
      Statement: [{ Resource: "arn:aws:s3:::my-bucket/products/*" }],
    };
    expect(bucketNameFromPolicy(policy)).toBe("my-bucket");
  });

  test("extracts the bucket name from a multi-resource array", () => {
    const policy = {
      Statement: [{ Resource: ["arn:aws:s3:::my-bucket/local/products/*", "arn:aws:s3:::my-bucket/dev/products/*"] }],
    };
    expect(bucketNameFromPolicy(policy)).toBe("my-bucket");
  });

  test("returns null when Statement is missing or malformed", () => {
    expect(bucketNameFromPolicy({})).toBeNull();
    expect(bucketNameFromPolicy({ Statement: "not-an-array" })).toBeNull();
  });
});

describe("buildVerifyTargets", () => {
  test("public key lives under products/, private key lives outside every public prefix", () => {
    const { publicKey, privateKey } = buildVerifyTargets("dev/");
    expect(publicKey).toMatch(/^dev\/products\/_policy-verify-\d+\.txt$/);
    expect(privateKey).toMatch(/^dev\/_policy-verify-private-\d+\.txt$/);
    expect(privateKey.startsWith("dev/products/")).toBe(false);
    expect(privateKey.startsWith("dev/content/")).toBe(false);
  });

  test("works with an empty prefix", () => {
    const { publicKey, privateKey } = buildVerifyTargets("");
    expect(publicKey).toMatch(/^products\/_policy-verify-\d+\.txt$/);
    expect(privateKey).toMatch(/^_policy-verify-private-\d+\.txt$/);
  });
});

describe("loadPolicyFile", () => {
  test("loads and strips the dev policy, covering local/dev products and content prefixes", () => {
    const { policy, policyJson } = loadPolicyFile("dev");
    expect(policy).not.toHaveProperty("_comment");
    expect(policyJson).not.toContain("_comment");
    const resources = (policy.Statement as Array<{ Resource: string[] }>)[0]?.Resource ?? [];
    expect(resources).toEqual(
      expect.arrayContaining([
        "arn:aws:s3:::ammaridev-uc1gfp/local/products/*",
        "arn:aws:s3:::ammaridev-uc1gfp/dev/products/*",
        "arn:aws:s3:::ammaridev-uc1gfp/local/content/*",
        "arn:aws:s3:::ammaridev-uc1gfp/dev/content/*",
        "arn:aws:s3:::ammaridev-uc1gfp/local/healthcheck/*",
      ]),
    );
  });

  test("refuses to load the prod policy while its bucket name placeholder is unfilled", () => {
    expect(() => loadPolicyFile("prod")).toThrow(/REPLACE_WITH_PROD_BUCKET_NAME/);
  });

  test("policyFilePath points at the package-root JSON files", () => {
    expect(policyFilePath("dev")).toMatch(/bucket-policy\.dev\.json$/);
    expect(policyFilePath("prod")).toMatch(/bucket-policy\.prod\.json$/);
  });
});
