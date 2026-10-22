// Client-side PDF hand-off shared by packing's sticker sheets and the shipping label (moved out of
// packing-list.tsx unchanged, Phase K2). Browser only.

/** iPadOS Safari reports its UA as a plain Mac ("Macintosh") since iPadOS 13 — the only reliable
 * way to tell it apart from a real Mac is that a touch-capable Mac UA is always an iPad (no
 * production Mac has a touchscreen). Needed because a synthetic `<a download>` click is
 * unreliable there for blob PDFs across iPadOS versions; opening the blob URL in a new tab
 * instead hands the PDF to Safari's own inline viewer, from which "Cetak"/"Simpan ke File" both
 * work via the share sheet — a better outcome there than a download that may silently do
 * nothing. */
export function isLikelyIPadSafari(): boolean {
  return typeof navigator !== "undefined" && /Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1;
}

/** On the iPad-Safari path, MUST be called synchronously inside the click handler that starts
 * the print — never after an `await` (the two server-action round-trips a real print goes
 * through). Safari only allows `window.open` to create a real, non-blocked window within an
 * actual user-gesture call stack; calling it once the PDF bytes are finally ready (well outside
 * that window) is the textbook case Safari's popup blocker exists to catch, and it fails
 * silently — `window.open` just returns `null`/an already-closed window, with nothing to show
 * for it even though the mint already committed server-side. Opening a blank tab immediately and
 * navigating it later (`popup.location.href = ...`) sidesteps this: the OPEN itself happens in
 * the gesture, only the navigation is deferred. Returns `null` on every other browser, where the
 * plain `<a download>` path below is used instead and no popup is needed at all. */
export function openStickerPopupPlaceholder(): Window | null {
  return isLikelyIPadSafari() ? window.open("", "_blank") : null;
}

/** `popup`: whatever `openStickerPopupPlaceholder` returned for THIS SAME click, or `null` on a
 * non-iPad-Safari browser. Returns an error message to show the staffer, or `null` on success. */
export function downloadOrOpenPdf(pdfBase64: string, filename: string, popup: Window | null): string | null {
  const binary = atob(pdfBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);

  if (isLikelyIPadSafari()) {
    if (!popup || popup.closed) {
      URL.revokeObjectURL(url);
      return "Pop-up diblokir. Izinkan pop-up untuk situs ini di pengaturan Safari, lalu coba lagi.";
    }
    popup.location.href = url;
  } else {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }
  // Delayed, not immediate — revoking right after `.click()`/navigating `popup` can race the
  // browser actually starting to read the blob in some engines.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return null;
}
