// Which deployed environment this process is, for the provider guards in payments/config.ts and
// shipping/config.ts (docs/plans/cart-checkout.md §12). One rule for both, failing closed: a typo
// (`prod`, `Production`) must never let prod run Midtrans in sandbox mode or a Biteship test key,
// and a production build that does not say which environment it is counts as production.

export type DeployEnvInput = Readonly<Record<string, string | undefined>>;

export const DEPLOY_ENV_VALUES = ["production", "dev", "development", "test"] as const;

export const DEPLOY_ENV_PROBLEM = "DEPLOY_ENV must be production, dev, development or test";

export interface DeployEnv {
  /** `DEPLOY_ENV=production`, or a production build (`NODE_ENV=production`) without `DEPLOY_ENV`. */
  isProductionDeploy: boolean;
  /** Set when `DEPLOY_ENV` holds anything outside the allowlist; the caller must refuse to run. */
  problem: string | null;
}

export function readDeployEnv(env: DeployEnvInput): DeployEnv {
  const deployEnv = env.DEPLOY_ENV?.trim() ?? "";
  const known = deployEnv === "" || (DEPLOY_ENV_VALUES as readonly string[]).includes(deployEnv);
  return {
    isProductionDeploy: deployEnv === "production" || (env.NODE_ENV === "production" && deployEnv === ""),
    problem: known ? null : DEPLOY_ENV_PROBLEM,
  };
}
