import { toNextJsHandler } from "better-auth/next-js";
import { customerAuth } from "@/lib/auth/customer";
import { mapLoginLinkRefusal } from "@/lib/auth/login-link-response";

const handlers = toNextJsHandler(customerAuth);

export const GET = handlers.GET;

// The login link's form POST lands on a page, never on a JSON refusal (lib/auth/login-link-response.ts).
export async function POST(request: Request): Promise<Response> {
  return mapLoginLinkRefusal(request, await handlers.POST(request));
}
