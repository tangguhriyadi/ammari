import "server-only";

/** Temporary stand-in for `store_settings.whatsapp_number` (docs/plans/storefront-cms.md Phase 2,
 * session 8 — not built yet). Until then, the PDP's WhatsApp CTA reads this env var instead;
 * `null` when unset, which every caller treats as "hide the button," never a broken `wa.me` link
 * with no number. Delete this function (and the env var) once store_settings ships — nothing
 * else in apps/web reads `STORE_WHATSAPP_NUMBER` directly, so that's a one-file change. */
export function getWhatsappNumber(): string | null {
  const raw = process.env.STORE_WHATSAPP_NUMBER;
  return raw && raw.trim().length > 0 ? raw.trim() : null;
}
