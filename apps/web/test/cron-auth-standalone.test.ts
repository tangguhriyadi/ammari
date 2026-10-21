import { afterAll, describe, expect, it } from "vitest";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ensureE2eDatabase } from "@ammari/db/test-e2e-db";

// The dev incident of 2026-10-21: every cron call answered 404 and web logged "[cron] internal
// cron route reached through a proxy; refused". lib/internal/cron-auth.ts treated a present
// `X-Forwarded-For` as "came through a proxy", but Next's own server fills in
// `x-forwarded-for` (from the socket address), `-host`, `-port` and `-proto` on every incoming
// request that lacks them (next/dist/server/base-server.js), so the cron container's direct curl
// carried it too. The route-level unit tests (api/internal/payments/sweep/route.test.ts) call
// the handler with a hand-built Request and never go through Next's server, which is why they
// missed it.
//
// So this test runs exactly what the image runs: a real `next build` (output: standalone) and
// `node <distDir>/standalone/apps/web/server.js`, then calls it with curl the way
// deploy/cron/cron.sh does (`-X POST -H @<header file>`). Slow (one full build), like
// test/homepage-deploy-regression.test.ts.

const execFileAsync = promisify(execFile);

const appRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const nextBin = path.join(appRoot, "node_modules", ".bin", "next");
// Must match next.config.ts's distDir for CRON_AUTH_STANDALONE_TEST.
const distDir = path.join(appRoot, ".next-cron-auth-test");
const serverJs = path.join(distDir, "standalone", "apps", "web", "server.js");

const SECRET = "cron-auth-standalone-test-secret-0123456789";
const BUILD_TIMEOUT_MS = 180_000;
const START_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = BUILD_TIMEOUT_MS + START_TIMEOUT_MS + 60_000;

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
  throw new Error(`standalone apps/web server on port ${port} never became healthy within ${deadlineMs}ms`);
}

/** POSTs like deploy/cron/cron.sh's `call`, plus any extra headers; returns the HTTP status. */
async function curlPost(url: string, headers: string[]): Promise<number> {
  const args = ["-sS", "-o", "/dev/null", "-X", "POST", "--max-time", "60", "-w", "%{http_code}"];
  for (const header of headers) args.push("-H", header);
  const { stdout } = await execFileAsync("curl", [...args, url]);
  return Number(stdout.trim());
}

describe("internal cron auth on the real standalone server", () => {
  let server: ChildProcess | undefined;
  let serverOutput = "";

  afterAll(async () => {
    if (!server) return;
    server.kill("SIGTERM");
    await new Promise((resolve) => server?.once("exit", resolve));
  });

  it(
    "accepts a direct curl with the right bearer, refuses one marked by Caddy or Cloudflare",
    async () => {
      const rawDatabaseUrl = process.env.DATABASE_URL;
      if (!rawDatabaseUrl) throw new Error("DATABASE_URL is not set");
      // `ammari_e2e` (disposable, migrated, seeded): retention deletes only rows past their age
      // limits, never the owner's `ammari` database.
      const e2eDatabaseUrl = await ensureE2eDatabase(rawDatabaseUrl);

      await rm(distDir, { recursive: true, force: true });
      // Same build environment as apps/web/Dockerfile's build stage.
      await runToCompletion(
        nextBin,
        ["build"],
        {
          ...process.env,
          NODE_ENV: "production",
          CRON_AUTH_STANDALONE_TEST: "true",
          DATABASE_URL: "postgresql://build:build@127.0.0.1:5432/build",
          BETTER_AUTH_URL: "http://localhost:3000",
          CUSTOMER_BETTER_AUTH_SECRET: "build-time-placeholder-not-a-real-secret",
        },
        BUILD_TIMEOUT_MS,
      );

      const port = await getFreePort();
      // The image's CMD (`node apps/web/server.js`) with its runtime env (NODE_ENV, PORT,
      // HOSTNAME); bound to loopback here only so the test never listens on the LAN.
      server = spawn(process.execPath, [serverJs], {
        cwd: path.dirname(serverJs),
        env: {
          ...process.env,
          NODE_ENV: "production",
          PORT: String(port),
          HOSTNAME: "127.0.0.1",
          DATABASE_URL: e2eDatabaseUrl,
          BETTER_AUTH_URL: `http://127.0.0.1:${port}`,
          CUSTOMER_BETTER_AUTH_SECRET: "cron-auth-test-secret-do-not-use-in-prod",
          INTERNAL_CRON_SECRET: SECRET,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      server.stdout?.on("data", (chunk: Buffer) => (serverOutput += chunk.toString()));
      server.stderr?.on("data", (chunk: Buffer) => (serverOutput += chunk.toString()));

      try {
        await waitUntilHealthy(port, START_TIMEOUT_MS);
        const url = `http://127.0.0.1:${port}/api/internal/retention`;
        const bearer = `authorization: Bearer ${SECRET}`;

        // What the cron container sends. Next adds X-Forwarded-* to it on the way in.
        expect(await curlPost(url, [bearer])).toBe(200);
        expect(serverOutput).not.toContain("reached through a proxy");

        expect(await curlPost(url, [])).toBe(401);
        expect(await curlPost(url, [`authorization: Bearer ${SECRET}x`])).toBe(401);

        // What Caddy (deploy*/caddy/Caddyfile) and Cloudflare add.
        expect(await curlPost(url, [bearer, "x-ammari-proxy: caddy"])).toBe(404);
        expect(await curlPost(url, [bearer, "cf-connecting-ip: 203.0.113.5"])).toBe(404);
        expect(await curlPost(url, [bearer, "cf-ray: 8f0c1e2d3a4b5c6d-SIN"])).toBe(404);
        expect(serverOutput).toContain("reached through a proxy");
        expect(serverOutput).not.toContain(SECRET);
      } catch (error) {
        throw new Error(`${(error as Error).message}\n--- standalone server output ---\n${serverOutput}`);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
