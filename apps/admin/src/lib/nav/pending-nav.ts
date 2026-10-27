/** A nav click that has not landed yet: the item's href, and the path it was clicked from. */
export interface PendingNav {
  href: string;
  from: string;
}

/** The nav's pending click, tagged with the pathname it belongs to. */
export interface NavPendingState {
  pathname: string;
  pending: PendingNav | null;
}

/** Any pathname change ends the pending click, whether it landed on its target or the user went
 * elsewhere. Returns the same object when nothing changed, so a provider can call it during
 * render and only set state when the result differs (no effect, no extra commit). Without this,
 * coming back to the page a click was made from (breadcrumb, browser back) would revive it. */
export function syncNavPending(state: NavPendingState, pathname: string): NavPendingState {
  return state.pathname === pathname ? state : { pathname, pending: null };
}

/** The path the nav highlights: the clicked item's href while the router is still on the page it
 * was clicked from (so the highlight moves on click, not when the new page arrives), otherwise the
 * real pathname. */
export function resolveNavPath(pathname: string, pending: PendingNav | null): string {
  return pending && pending.from === pathname ? pending.href : pathname;
}

/** Whether a click on a nav link is a plain in-app navigation. Modifier or non-primary clicks open
 * a new tab/window and leave this page where it is, so they must not move the highlight. */
export function isPlainLeftClick(event: {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
}): boolean {
  return (
    event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.defaultPrevented
  );
}
