// The private-upload refusals (docs/plans/purchase-payments.md §6), in a module with no server
// dependency so the file picker can show exactly the text the server would. The server
// (proof-processing.ts) remains the real guard: it decides from the bytes, never the file name.

export const PROOF_MESSAGES = {
  missing: "Bukti bayar wajib diunggah.",
  unsupported: "Format file tidak didukung. Gunakan foto JPG, PNG, WebP, atau PDF.",
  tooLarge: "Ukuran file maksimal 10 MB.",
  heic: "Foto HEIC belum didukung. Ubah ke JPG lalu unggah ulang.",
  unreadable: "Foto tidak bisa dibaca: rusak atau dimensinya terlalu besar.",
  pdfUnreadable: "PDF tidak bisa dibaca atau rusak. Unggah ulang, atau kirim foto/screenshot buktinya.",
  pdfActive: "PDF ini berisi skrip atau lampiran tersembunyi. Unggah foto/screenshot buktinya saja.",
} as const;

export const PRIVATE_UPLOAD_MAX_INPUT_BYTES = 10 * 1024 * 1024;

/** The picker's accept list (§6): iOS transcodes a HEIC photo to JPEG for it. No `capture`, so
 * the phone offers both the camera and the gallery. */
export const PRIVATE_UPLOAD_ACCEPT = "image/jpeg,image/png,image/webp,application/pdf";
