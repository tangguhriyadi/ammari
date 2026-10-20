import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { IMAGE_SIZES } from "@/lib/storage/public-url";
import { isE2eFixturesRequestAllowed } from "@/lib/fixtures/e2e-fixtures-gate";

// e2e-only backdoor: serves the committed fixture WebP images storefront-fixtures.ts points
// product/content storageKeys at (apps/web/e2e/fixtures/*), so an e2e run against `next dev`
// gets real, fetchable image URLs — without those test images ever shipping in the production
// Docker image (Dockerfile only COPYs apps/web/public, never apps/web/e2e). See
// e2e-fixtures-gate.ts for the three fail-closed conditions, and deploy/Caddyfile's /api/test/*
// edge block for the belt-and-suspenders that covers this path too, same as every other
// /api/test/* backdoor in this app.
const FIXTURES_ROOT = resolve(process.cwd(), "e2e", "fixtures");
const NAME_PATTERN = /^[a-z0-9-]+$/;
const FILE_PATTERN = new RegExp(`^((${IMAGE_SIZES.join("|")})\\.webp|og\\.jpg)$`);

function notFound(): NextResponse {
  return NextResponse.json({ error: "not_found" }, { status: 404 });
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }): Promise<NextResponse> {
  const allowed = isE2eFixturesRequestAllowed({
    nodeEnv: process.env.NODE_ENV,
    e2eTestLoginFlag: process.env.E2E_TEST_LOGIN,
    host: request.headers.get("host"),
  });
  if (!allowed) return notFound();

  const { path } = await params;
  const [name, file] = path;
  // Strict allowlist, not just "no ..": every fixture is exactly <name>/<size>.webp (or the Hero's
  // generated <name>/og.jpg), so nothing else should ever resolve, regardless of how the segment
  // got encoded.
  if (path.length !== 2 || !name || !file || !NAME_PATTERN.test(name) || !FILE_PATTERN.test(file)) {
    return notFound();
  }

  const filePath = resolve(FIXTURES_ROOT, name, file);
  if (!filePath.startsWith(`${FIXTURES_ROOT}/`)) return notFound();

  try {
    const body = await readFile(filePath);
    return new NextResponse(body, { headers: { "Content-Type": file.endsWith(".jpg") ? "image/jpeg" : "image/webp" } });
  } catch {
    return notFound();
  }
}
