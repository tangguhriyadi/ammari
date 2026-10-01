import { toNextJsHandler } from "better-auth/next-js";
import { staffAuth } from "@/lib/auth/staff";

export const { GET, POST } = toNextJsHandler(staffAuth);
