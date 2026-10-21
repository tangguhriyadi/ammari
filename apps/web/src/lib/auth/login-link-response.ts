import { LOGIN_LINK_CONSUME_ACTION, LOGIN_LINK_PAGE_PATH } from "./login-link-paths";

/** The login link's form POST is a full page navigation, so a refusal Better Auth answers before
 * the plugin's own handler runs (its rate limiter's 429, the CSRF middleware's 403, a wrong content
 * type) would show the buyer a bare JSON body. This turns those into a redirect back to the confirm
 * page with a status it explains. Every other auth endpoint, and the plugin's own redirects, pass
 * through untouched. */
export function mapLoginLinkRefusal(request: Request, response: Response): Response {
  if (new URL(request.url).pathname !== LOGIN_LINK_CONSUME_ACTION) return response;
  if (response.status >= 300 && response.status < 400) return response;
  const status = response.status === 429 ? "limited" : response.status === 403 ? "blocked" : "error";
  // Status only: the token is in the form body, which is never read or logged here.
  console.warn("[login-link] login POST refused before the handler", { status: response.status, shown: status });
  return new Response(null, { status: 303, headers: { Location: `${LOGIN_LINK_PAGE_PATH}?status=${status}`, "Cache-Control": "no-store" } });
}
