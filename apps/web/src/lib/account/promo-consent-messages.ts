// "Kabar promo" messages, outside promo-consent.ts (server-only) so the /account section can show
// the same text when the action does not answer.
export const PROMO_CONSENT_FAILED_MESSAGE = "Pilihan promo belum tersimpan. Coba lagi sebentar lagi.";
export const PROMO_CONSENT_INVALID_MESSAGE = "Pilihan tidak dikenal. Muat ulang halaman ini.";

/** The sentence shown above "Terima kabar promo": what the buyer agrees to. Stored verbatim in the
 * audit row of each self-serve opt-in, as the record of the consent text shown at that moment. */
export const PROMO_CONSENT_TEXT = "Dengan menekan tombol ini, kamu setuju dikirimi kabar koleksi baru dan promo dari Ammari. Bisa dihentikan kapan saja di sini.";
