// Photo-rule messages shared by the server guards (image-queries.ts, storefront.ts) and the
// "Toko online" card (storefront-section.tsx), which matches on them to offer a "Buka bagian Foto"
// shortcut. A plain module (not server-only) so the client card can import it.
//
// No position words ("di bawah"/"di atas"): where the Foto section sits relative to a message
// depends on the layout, so messages name the section instead and the card links to it.

export const PUBLISH_REQUIRES_PHOTO_MESSAGE =
  "Produk belum punya foto. Unggah minimal satu foto di bagian Foto sebelum menayangkannya di toko online.";
export const PUBLISH_ALT_TEXT_MESSAGE =
  "Semua foto produk harus memiliki teks alternatif sebelum bisa ditayangkan di toko online. Lengkapi teks alternatif di bagian Foto.";
export const PUBLISHED_LAST_PHOTO_MESSAGE =
  "Tidak bisa menghapus foto terakhir selagi produk tayang di toko online. Unggah foto lain dulu, atau matikan tayang di toko online.";

/** Messages the "Toko online" card answers with a jump to the Foto section. */
export const PHOTO_SECTION_MESSAGES: readonly string[] = [PUBLISH_REQUIRES_PHOTO_MESSAGE, PUBLISH_ALT_TEXT_MESSAGE];

/** The Foto section's DOM id: the jump target (scrolled to and focused). */
export const PHOTO_SECTION_ID = "product-photos";
