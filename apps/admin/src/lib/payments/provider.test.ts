import { describe, expect, test, vi } from "vitest";
import { getAdminPaymentProvider } from "./provider";

// Admin never verifies a notification, so MIDTRANS_SIGNATURE_KEY (web only) must not decide
// whether staff cancels can reach the gateway.

describe("getAdminPaymentProvider", () => {
  test("a malformed MIDTRANS_SIGNATURE_KEY in admin's environment is ignored", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const env: NodeJS.ProcessEnv = { NODE_ENV: "test", MIDTRANS_SERVER_KEY: ["Mid", "server", "FAKEADMIN0000000000000000"].join("-"), MIDTRANS_IS_PRODUCTION: "false", DEPLOY_ENV: "dev" };
      expect(getAdminPaymentProvider({ ...env, MIDTRANS_SIGNATURE_KEY: "not:a key" })?.name).toBe("midtrans");
      expect(getAdminPaymentProvider({ ...env, MIDTRANS_SERVER_KEY: "" })).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
