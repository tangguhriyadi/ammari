// Storefront shipping messages (docs/plans/cart-checkout.md §4.5.1, §4.5.5). Indonesian, no em
// dash, never naming the shipping provider or any city.

export const AREA_SEARCH_MIN_LENGTH = 3;
export const AREA_SEARCH_MAX_LENGTH = 60;

export const AREA_SEARCH_TOO_SHORT_MESSAGE = "Ketik minimal 3 huruf.";
export const AREA_SEARCH_TOO_LONG_MESSAGE = "Pencarian terlalu panjang.";
export const AREA_SEARCH_RATE_LIMITED_MESSAGE = "Terlalu banyak pencarian. Coba lagi sebentar lagi.";
export const AREA_SEARCH_UNAVAILABLE_MESSAGE = "Pencarian alamat belum bisa dipakai. Coba lagi sebentar lagi.";
export const SHIPPING_GENERIC_ERROR_MESSAGE = "Terjadi kesalahan. Coba lagi.";

/** Per IP, area searches (plan §4.5.1 `area_search`: 60 per 10 minutes). The combobox searches
 * after 3 characters with a 300 ms debounce, so a buyer typing a kecamatan uses a handful. */
export const AREA_SEARCH_WINDOW_SECONDS = 600;
export const AREA_SEARCH_LIMIT = 60;
