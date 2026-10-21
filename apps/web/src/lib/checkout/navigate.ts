// A full page load to the payment page (or the finish page). Not the Next router: the payment page
// is another site (the gateway) or, in e2e, a route handler that is not a React page. Its own
// module so component tests can observe it.
//
// The URL comes from our own server (the provider's answer stored by placeOrder), never from the
// buyer; still, only an https page or a page on this site is ever opened, so a bad provider answer
// can never navigate to a javascript: or plain-http URL.
export function isSafePaymentUrl(url: string, origin: string): boolean {
  try {
    const parsed = new URL(url, origin);
    return parsed.origin === origin || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** Opens the page; false (and nothing opened) when the URL is neither https nor this site. */
export function goToPaymentPage(url: string): boolean {
  if (!isSafePaymentUrl(url, window.location.origin)) {
    console.error("[checkout] refused to open a payment page that is neither https nor this site");
    return false;
  }
  window.location.assign(url);
  return true;
}
