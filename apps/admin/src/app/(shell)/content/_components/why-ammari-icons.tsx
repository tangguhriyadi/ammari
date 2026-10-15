import { Baby, Droplets, EyeOff, Gem, MessageCircle, Scissors, Shirt, Wind, type LucideIcon } from "lucide-react";
import type { WhyAmmariIconKey } from "@ammari/db/why-ammari";

// ---------- "Kenapa Ammari" icon key -> lucide-react component (docs/plans/storefront-cms.md) ----------
//
// The KEY set and its Indonesian LABELS live in `@ammari/db/why-ammari` (shared with apps/web,
// a later session) — this key -> icon-component mapping is admin-local, same "key<->label in
// packages/db, key<->icon-component in the consuming app" split that module's own doc comment
// describes; apps/web picks its own icon mapping independently when it builds the public
// section (session 7), it doesn't have to match this one icon-for-icon.
export const WHY_AMMARI_ICON_COMPONENTS: Record<WhyAmmariIconKey, LucideIcon> = {
  syari_design: Shirt,
  premium_fabric: Gem,
  careful_tailoring: Scissors,
  all_day_comfort: Wind,
  easy_care: Droplets,
  not_see_through: EyeOff,
  nursing_friendly: Baby,
  responsive_service: MessageCircle,
};
