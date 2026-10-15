import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { defaultDb } from "@/lib/db";

// Deploy-pipeline liveness/readiness probe (docs/deploy.md) — polled by deploy/remote-deploy.sh
// after a restart, and by Docker Compose's own `healthcheck:`. Deliberately unauthenticated (it
// must be reachable before any session exists) and deliberately thin: no auth check, no env var
// names, no error messages or stack traces in the body — just ok/fail, so it's safe to leave
// world-reachable behind Caddy. A short timeout keeps a slow/unreachable database from hanging
// the probe itself rather than failing it quickly.
const DB_TIMEOUT_MS = 2000;

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error("db health check timed out")), ms));
}

export async function GET(): Promise<NextResponse> {
  try {
    await Promise.race([defaultDb.execute(sql`select 1`), timeout(DB_TIMEOUT_MS)]);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}
