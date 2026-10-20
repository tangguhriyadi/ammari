import { revalidatePath, revalidateTag } from "next/cache";
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
// `tags` exists alongside `paths` because `/` (app/page.tsx) is `dynamic = "force-dynamic"` —
// it has no Full Route Cache entry for `revalidatePath` to invalidate at all, so the homepage's
// own cached data (lib/content/homepage-data.ts's `unstable_cache` calls) can only be refreshed
// on demand via its tag. `paths` stays for routes that DO still have a route-level ISR cache
// entry (e.g. `/products/[slug]`). `layouts` revalidates a LAYOUT path and every page beneath it
// (`revalidatePath(path, "layout")`): store settings render in the root layout (announcement bar,
// footer contact) on every page, including the ISR-cached `/products/[slug]` pages, so a settings
// save sends `layouts: ["/"]`.
const pathListSchema = z
  .array(z.string().min(1).startsWith("/", "Setiap path harus diawali \"/\"."))
  .min(1)
  .max(10)
  .optional();

const bodySchema = z
  .object({
    paths: pathListSchema,
    layouts: pathListSchema,
    tags: z.array(z.string().min(1)).min(1).max(10).optional(),
  })
  .refine((body) => (body.paths?.length ?? 0) + (body.layouts?.length ?? 0) + (body.tags?.length ?? 0) > 0, {
    message: "Provide at least one path, layout or tag.",
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

  const paths = parsed.data.paths ?? [];
  const layouts = parsed.data.layouts ?? [];
  const tags = parsed.data.tags ?? [];
  for (const path of paths) {
    revalidatePath(path);
  }
  for (const layout of layouts) {
    revalidatePath(layout, "layout");
  }
  for (const tag of tags) {
    // `{ expire: 0 }`, not the (deprecated, TS-error) single-arg form or `"max"` — this call
    // comes from apps/admin's Route Handler, not a Server Action co-located with the page that
    // reads the tag, so there is no automatic "revalidate on next navigation to the affected
    // page" to fall back on; `{ expire: 0 }` forces the very next request for this tag's data to
    // be a fresh read instead of stale-while-revalidate, matching what `revalidatePath` already
    // guarantees for `/products/[slug]`.
    revalidateTag(tag, { expire: 0 });
  }

  return NextResponse.json({ ok: true, revalidated: { paths, layouts, tags } });
}
