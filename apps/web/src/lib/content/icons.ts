import {
  Baby,
  Droplets,
  EyeOff,
  Gem,
  MessageCircle,
  Scissors,
  Shirt,
  Snowflake,
  Sparkles,
  Wind,
  type LucideIcon,
} from "lucide-react";
import type { ProductHighlightKey } from "@ammari/db/highlights";
import type { WhyAmmariIconKey } from "@ammari/db/why-ammari";

/** apps/web's own key -> icon mapping for "Kenapa Ammari" (docs/plans/storefront-cms.md: "apps/web
 * picks its own mapping independently" of apps/admin's icon picker — same keys, each app owns its
 * own icon choice). */
export const WHY_AMMARI_ICONS: Record<WhyAmmariIconKey, LucideIcon> = {
  syari_design: Shirt,
  premium_fabric: Gem,
  careful_tailoring: Scissors,
  all_day_comfort: Wind,
  easy_care: Droplets,
  not_see_through: EyeOff,
  nursing_friendly: Baby,
  responsive_service: MessageCircle,
};

/** The PDP's "Keunggulan" numbered rows (docs/design/storefront.md §6 item 8) each pair the
 * canonical label with one icon — apps/web's own mapping, same "picks its own" reasoning as
 * above. */
export const PRODUCT_HIGHLIGHT_ICONS: Record<ProductHighlightKey, LucideIcon> = {
  breathable: Wind,
  flowy: Sparkles,
  falls_perfectly: Gem,
  cool_fabric: Snowflake,
  not_see_through: EyeOff,
};
