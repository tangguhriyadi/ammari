// @ammari/email (docs/plans/email-design.md): the shared Ammari email layout and the emails that
// have no other home (sign-in codes, staff invite). Pure string rendering, safe on both server and
// in scripts; sending lives in @ammari/auth (EmailSender) and @ammari/commerce (order emails).

export { EMAIL_COLOR, EMAIL_CONTACT, EMAIL_FONT, EMAIL_LOGO_PATH, emailLogoUrl } from "./brand";
export { escapeHtml, formatWib, formatWibTime } from "./format";
export { button, code, details, divider, heading, link, muted, paragraph, renderEmail, type EmailLayoutInput, type EmailSection, type RenderedEmail } from "./layout";
export { renderSignInCodeEmail, type SignInCodeEmailInput } from "./sign-in-code";
export { renderStaffInviteEmail, staffInviteLoginLink, type StaffInviteEmailInput } from "./staff-invite";
