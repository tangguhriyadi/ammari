import { toNextJsHandler } from "better-auth/next-js";
import { customerAuth } from "@/lib/auth/customer";

export const { GET, POST } = toNextJsHandler(customerAuth);
