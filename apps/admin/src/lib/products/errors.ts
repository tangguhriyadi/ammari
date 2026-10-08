// Re-exported for this feature's existing call sites (`from "./errors"`) — the real definitions
// are shared across every feature now (@/lib/errors), not products-specific.
export { ActionError, FieldError, isPostgresErrorCode, mapUniqueViolation } from "@/lib/errors";
