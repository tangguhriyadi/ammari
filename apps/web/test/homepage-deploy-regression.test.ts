import { afterAll, describe, expect, it } from "vitest";
import { type ChildProcess, spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { storefrontHomepageSections } from "@ammari/db/schema";
import { ensureE2eDatabase } from "@ammari/db/test-e2e-db";

// Reproduces the session-7 dev incident directly: apps/web's production image is built ONCE in
// CI against an unreachable placeholder DATABASE_URL (apps/web/Dockerfile), then deployed and
// started against the real database. `/` has no dynamic route segment, so before this bug was
// fixed, Next attempted to prerender it during that placeholder-DB build — producing an EMPTY
// static HTML snapshot — and then served that exact snapshot, unchanged, for up to its 1h
// `revalidate` window after every fresh deploy, even though real homepage content was already
// published. The fix (`dynamic = "force-dynamic"` on app/page.tsx, see its own doc comment) means
// this route is never prerendered at build at all, so there is no stale snapshot to serve; this
// test proves that end-to-end with a REAL `next build` (unreachable DB) followed by a REAL
// `next start` (real DB) — a plain unit test can't reproduce this, since it never runs `next
// build`/`next start` at all, and Next's own dev server (`next dev`) never produces a static
// snapshot in the first place (pages are always rendered on-demand in dev).
//
// This is the one test in this repo that drives the full build+start lifecycle instead of
// `next dev` or a mocked module — expect it to be the slowest test in the suite.
//
// Uses `next start`, not the Dockerfile's `node .next/standalone/server.js` (which prints a
// "doesn't work with output: standalone" warning here) — `output: standalone` only changes which
// files get traced/copied for the container image, not the prerender/ISR logic this test is
// actually exercising, so `next start` against the same build output is a faithful enough stand-
// in without the extra brittleness of resolving and serving the standalone copy's own static/
// public paths.

const appRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const nextBin = path.join(appRoot, "node_modules", ".bin", "next");
// Must match next.config.ts's distDir for DEPLOY_REGRESSION_TEST.
const distDir = path.join(appRoot, ".next-deploy-regression-test");

const BUILD_TIMEOUT_MS = 120_000;
const START_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = BUILD_TIMEOUT_MS + START_TIMEOUT_MS + 30_000;

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("could not determine a free port"));
      });
    });
  });
}

function runToCompletion(command: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: appRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} ${args.join(" ")} timed out after ${timeoutMs}ms\n${output}`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with code ${code}\n${output}`));
    });
  });
}

async function waitUntilHealthy(port: number, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch {
      // Server socket not open yet — keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`apps/web server on port ${port} never became healthy within ${deadlineMs}ms`);
}

describe("homepage deploy regression", () => {
  let server: ChildProcess | undefined;
  let serverOutput = "";

  afterAll(async () => {
    if (!server) return;
    server.kill("SIGTERM");
    await new Promise((resolve) => server?.once("exit", resolve));
  });

  it(
    "renders already-published homepage content on the very first request after a fresh deploy, with no revalidate/publish call",
    async () => {
      const rawDatabaseUrl = process.env.DATABASE_URL;
      if (!rawDatabaseUrl) throw new Error("DATABASE_URL is not set");

      // `ammari_e2e`: created fresh, migrated, and baseline-seeded, same as Playwright's own
      // global setup — never the owner's real dev `ammari` database or `ammari_test`.
      const e2eDatabaseUrl = await ensureE2eDatabase(rawDatabaseUrl);

      // Simulates the real incident's starting condition: the owner already published homepage
      // content in admin BEFORE this deploy's build ran. A heading unique to this run proves the
      // response below came from THIS seed, not a leftover/cached one.
      const heading = `Regression test heading ${Date.now()}`;
      const seedClient = postgres(e2eDatabaseUrl, { max: 1 });
      try {
        const seedDb = drizzle(seedClient);
        await seedDb
          .update(storefrontHomepageSections)
          .set({
            publishedIsVisible: true,
            publishedContent: {
              eyebrow: "Kenapa Ammari",
              heading,
              points: [{ icon: "premium_fabric", title: "Bahan premium", text: "Nyaman dipakai seharian." }],
            },
            publishedAt: new Date(),
          })
          .where(eq(storefrontHomepageSections.key, "why_ammari"));
      } finally {
        await seedClient.end();
      }

      // Start from an empty distDir, as CI does (fresh checkout, `.next` excluded by
      // .dockerignore). `unstable_cache` (lib/content/homepage-data.ts) persists its entries to
      // `<distDir>/cache/fetch-cache`, and `next build` does NOT clear that folder. Reusing the
      // previous run's distDir therefore served the previous run's heading: fresh within the
      // 1h TTL, and still once more after it (stale-while-revalidate), so this test failed on
      // every run after the first. Production never has that leftover: the image copies only
      // `.next/standalone`, `.next/static` and `public`, and the container has no volume.
      await rm(distDir, { recursive: true, force: true });

      // Mirrors apps/web/Dockerfile's build stage EXACTLY: production build against an
      // unreachable placeholder DATABASE_URL, deployed environment-neutral.
      await runToCompletion(
        nextBin,
        ["build"],
        {
          ...process.env,
          NODE_ENV: "production",
          DEPLOY_REGRESSION_TEST: "true",
          DATABASE_URL: "postgresql://build:build@127.0.0.1:5432/build",
          BETTER_AUTH_URL: "http://localhost:3000",
          CUSTOMER_BETTER_AUTH_SECRET: "build-time-placeholder-not-a-real-secret",
        },
        BUILD_TIMEOUT_MS,
      );

      const port = await getFreePort();
      server = spawn(nextBin, ["start", "--port", String(port)], {
        cwd: appRoot,
        env: {
          ...process.env,
          NODE_ENV: "production",
          DEPLOY_REGRESSION_TEST: "true",
          DATABASE_URL: e2eDatabaseUrl,
          BETTER_AUTH_URL: `http://127.0.0.1:${port}`,
          CUSTOMER_BETTER_AUTH_SECRET: "e2e-regression-test-secret-do-not-use-in-prod",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      server.stdout?.on("data", (chunk: Buffer) => (serverOutput += chunk.toString()));
      server.stderr?.on("data", (chunk: Buffer) => (serverOutput += chunk.toString()));

      try {
        await waitUntilHealthy(port, START_TIMEOUT_MS);

        // The entire point of this test: no call to /api/revalidate, no "Terbitkan" action — just
        // a plain GET, exactly what a real visitor's first request after a fresh deploy looks
        // like. Before the fix this returned the empty HTML baked in by the build above; after
        // the fix it renders fresh from `e2eDatabaseUrl`.
        const response = await fetch(`http://127.0.0.1:${port}/`);
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain(heading);
      } catch (error) {
        throw new Error(`${(error as Error).message}\n--- next start output ---\n${serverOutput}`);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
