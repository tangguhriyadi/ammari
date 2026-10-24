/** The desktop sidebar's collapsed/expanded choice, remembered per browser in a cookie so the
 * server can render the first paint already in the right state (no flash, no layout shift). A
 * cookie, not localStorage: localStorage is unreadable on the server, so the first render would
 * always be "expanded" and snap to the rail after hydration. */
export const SIDEBAR_COOKIE_NAME = "ammari-admin-sidebar";

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/** Anything other than the exact stored "collapsed" value (missing, stale, tampered) is expanded. */
export function parseSidebarCollapsed(value: string | undefined | null): boolean {
  return value === "collapsed";
}

export function serializeSidebarCookie(collapsed: boolean): string {
  const value = collapsed ? "collapsed" : "expanded";
  return `${SIDEBAR_COOKIE_NAME}=${value}; Path=/; Max-Age=${ONE_YEAR_SECONDS}; SameSite=Lax`;
}

/** Client-side write; takes the `document`-like target so it can be unit tested without a DOM. */
export function writeSidebarPreference(collapsed: boolean, target: { cookie: string }): void {
  target.cookie = serializeSidebarCookie(collapsed);
}
