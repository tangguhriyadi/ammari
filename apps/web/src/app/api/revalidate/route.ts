import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { z } from "zod";
import { isValidRevalidateSecret } from "@/lib/revalidate/secret";

// Secret-gated, machine-to-machine only — called by apps/admin over the INTERNAL Docker network
// (http://web:3000/api/revalidate), never the public domain (docs/plans/storefront-cms.md
// session 6). No staff session exists here at all, so the shared secret IS the whole auth
// boundary — see secret.ts's own doc comment on why that comparison is constant-time.
//
// Defense in depth against the secret ever leaking: deploy/Caddyfile blocks this exact path on
// the public hostname (ammari.my.id/www), so even a leaked secret can't be used from the public
// internet — Cloudflare's Authenticated Origin Pulls only proves a request came THROUGH
// Cloudflare, not that it's a legitimate admin request, so without that Caddy block any public
// visitor would still reach this route via the normal reverse_proxy. The internal
// admin -> web:3000 call bypasses Caddy entirely (same Docker network, no published port
// involved), so it's never affected by that block.
const bodySchema = z.object({
  paths: z
    .array(z.string().min(1).startsWith("/", "Setiap path harus diawali \"/\"."))
    .min(1)
    .max(10),
});

export async function POST(request: Request): Promise<NextResponse> {
  const secret = request.headers.get("x-revalidate-secret");
  if (!isValidRevalidateSecret(secret)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "invalid body" }, { status: 400 });
  }

  for (const path of parsed.data.paths) {
    revalidatePath(path);
  }

  return NextResponse.json({ ok: true, revalidated: parsed.data.paths });
}
