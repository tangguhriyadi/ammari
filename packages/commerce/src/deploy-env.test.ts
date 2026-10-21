import { describe, expect, test } from "vitest";
import { DEPLOY_ENV_PROBLEM, readDeployEnv } from "./deploy-env";

describe("readDeployEnv", () => {
  test("production only when it says so, or a production build says nothing", () => {
    expect(readDeployEnv({ DEPLOY_ENV: "production" })).toEqual({ isProductionDeploy: true, problem: null });
    expect(readDeployEnv({ DEPLOY_ENV: " production\t" })).toEqual({ isProductionDeploy: true, problem: null });
    expect(readDeployEnv({ NODE_ENV: "production" })).toEqual({ isProductionDeploy: true, problem: null });
    expect(readDeployEnv({ NODE_ENV: "production", DEPLOY_ENV: "" })).toEqual({ isProductionDeploy: true, problem: null });
    expect(readDeployEnv({ NODE_ENV: "production", DEPLOY_ENV: "dev" })).toEqual({ isProductionDeploy: false, problem: null });
    expect(readDeployEnv({})).toEqual({ isProductionDeploy: false, problem: null });
  });

  test("anything outside the allowlist is a problem and never production", () => {
    for (const value of ["prod", "Production", "PRODUCTION", "staging", "dev,production"]) {
      expect(readDeployEnv({ NODE_ENV: "production", DEPLOY_ENV: value })).toEqual({ isProductionDeploy: false, problem: DEPLOY_ENV_PROBLEM });
    }
    for (const value of ["dev", "development", "test"]) {
      expect(readDeployEnv({ DEPLOY_ENV: value }).problem).toBeNull();
    }
  });
});
