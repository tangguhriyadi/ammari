import type { BreadcrumbItem } from "@ammari/ui";
import { rootCrumbs } from "../nav/breadcrumb";
import { INTEGRATIONS_PATH, type IntegrationTab } from "./tabs";

/** Administrasi / Integrasi / <tab>; pages under a tab add their own trailing crumb. */
export function integrationCrumbs(tab: IntegrationTab): BreadcrumbItem[] {
  return [...rootCrumbs(INTEGRATIONS_PATH), { label: tab.label, href: tab.href }];
}
