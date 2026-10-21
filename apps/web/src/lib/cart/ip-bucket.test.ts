import { describe, expect, test } from "vitest";
import { rateLimitBucketForIp } from "./ip-bucket";

describe("rateLimitBucketForIp", () => {
  test.each([
    ["203.0.113.10", "203.0.113.10"],
    ["2001:db8:1:2:3:4:5:6", "2001:db8:1:2::"],
    ["2001:0db8:0001:0002:aaaa:bbbb:cccc:dddd", "2001:db8:1:2::"],
    ["2001:db8::1", "2001:db8:0:0::"],
    ["2001:db8:1:2::", "2001:db8:1:2::"],
    ["::1", "0:0:0:0::"],
    ["::ffff:203.0.113.5", "203.0.113.5"],
    ["64:ff9b::203.0.113.5", "64:ff9b:0:0::"],
    ["fe80::1%en0", "fe80:0:0:0::"],
    ["not an ip", null],
    ["", null],
  ])("%s -> %s", (ip, bucket) => {
    expect(rateLimitBucketForIp(ip)).toBe(bucket);
  });

  test("every address in one /64 shares a bucket; another /64 does not", () => {
    expect(rateLimitBucketForIp("2001:db8:1:2::1")).toBe(rateLimitBucketForIp("2001:db8:1:2:ffff:ffff:ffff:ffff"));
    expect(rateLimitBucketForIp("2001:db8:1:3::1")).not.toBe(rateLimitBucketForIp("2001:db8:1:2::1"));
  });
});
