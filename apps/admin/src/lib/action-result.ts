import { ActionError, FieldError } from "./errors";

// Server Actions are a public network endpoint regardless of how the client invokes them
// (<form action> or a direct call) — Next also redacts a thrown Error's message in production
// unless it's returned as plain data, so every action converts FieldError/ActionError into a
// structured result rather than letting them propagate as thrown errors across the boundary.
export type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

export async function runAction<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    const data = await fn();
    return { ok: true, data };
  } catch (error) {
    if (error instanceof FieldError) return { ok: false, error: error.message, fieldErrors: { [error.field]: error.message } };
    if (error instanceof ActionError) return { ok: false, error: error.message };
    throw error; // a real bug, or a Next interrupt (redirect/forbidden) re-thrown from requirePermission
  }
}
