import { createServer } from "node:http";
import type { APIRequestContext } from "@playwright/test";

// A stand-in for apps/web's secret-gated `/api/revalidate` (see src/lib/revalidate.ts). e2e never
// runs apps/web, so without this every storefront revalidation call fails and the product form
// takes its "saved, but the storefront is stale" branch (stays on the form) instead of the normal
// redirect. Started by global-setup.ts on 127.0.0.1 only; playwright.config.ts points the e2e
// server's WEB_INTERNAL_URL here. It also records every call, so a spec can assert the storefront
// revalidation still fires with the right paths.
export const STOREFRONT_STUB_PORT = 3198;
const STUB_ORIGIN = `http://127.0.0.1:${STOREFRONT_STUB_PORT}`;
const CALLS_PATH = "/__e2e/calls";

export interface StorefrontRevalidateCall {
  paths: string[];
  tags: string[];
  secretMatched: boolean;
}

/** Starts the stub and resolves with a function that stops it. */
export function startStorefrontStub(revalidateSecret: string | undefined): Promise<() => Promise<void>> {
  const calls: StorefrontRevalidateCall[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method === "GET" && request.url === CALLS_PATH) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(calls));
        return;
      }
      if (request.method === "POST" && request.url === "/api/revalidate") {
        // Never throw here: this runs in the Playwright runner process, so an uncaught error from a
        // malformed body would take down the whole e2e run instead of failing one request.
        let body: { paths?: unknown; tags?: unknown };
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { paths?: unknown; tags?: unknown };
        } catch {
          response.writeHead(400);
          response.end();
          return;
        }
        calls.push({
          paths: Array.isArray(body.paths) ? body.paths.map(String) : [],
          tags: Array.isArray(body.tags) ? body.tags.map(String) : [],
          secretMatched: Boolean(revalidateSecret) && request.headers["x-revalidate-secret"] === revalidateSecret,
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ revalidated: true }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(STOREFRONT_STUB_PORT, "127.0.0.1", () => {
      resolve(
        () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      );
    });
  });
}

/** Every revalidation call the stub has received so far, oldest first. */
export async function storefrontRevalidateCalls(request: APIRequestContext): Promise<StorefrontRevalidateCall[]> {
  const response = await request.get(`${STUB_ORIGIN}${CALLS_PATH}`);
  if (!response.ok()) throw new Error(`storefront stub: ${response.status()}`);
  return (await response.json()) as StorefrontRevalidateCall[];
}
