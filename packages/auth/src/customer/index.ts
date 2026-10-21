export { createCustomerAuth } from "./create-customer-auth";
export type { CreateCustomerAuthOptions, GoogleProviderOverrides, CustomerAuth } from "./create-customer-auth";
export { loadOrCreateCustomerForEmail, getCustomerOtpResendState } from "./customer-data";
export type { CustomerIdentity, OtpResendState } from "./customer-data";
export {
  LOGIN_LINK_MAX_PER_DAY,
  LOGIN_LINK_TTL_HOURS,
  consumeCustomerLoginLink,
  findLiveCustomerLoginLink,
  hashLoginLinkToken,
  isWellFormedLoginLinkToken,
  issueOrReuseCustomerLoginLink,
  maskEmail,
  releaseConsumedLoginLink,
} from "./login-link";
export type { ConsumedLoginLink, IssueLoginLinkInput, IssueLoginLinkResult, LiveLoginLink } from "./login-link";
export { ORDER_LOGIN_LINK_CONSUME_PATH } from "./order-login-link-plugin";
export type { OrderLoginLinkStatus } from "./order-login-link-plugin";
