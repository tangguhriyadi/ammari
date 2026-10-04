"use client";

import { useEffect, useLayoutEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, Loader2, MoreHorizontal, Pencil, Star, Trash2 } from "lucide-react";
import { cn, Dialog, Input } from "@ammari/ui";
import { deleteProductImageAction, setProductThumbnailAction, updateImageAltTextAction } from "../actions";
import { ProductImage } from "./product-image";
import type { PhotoImage } from "./photo-types";

interface MenuItem {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}

/** A small overflow menu, not a full ARIA APG menu (no arrow-key roving tabindex) — each item
 * is a real, Tab-reachable button, which is enough for a 4-5 item list like this one. Closes on
 * outside click or Escape. */
function PhotoTileMenu({ items, pending }: { items: MenuItem[]; pending: boolean }) {
  const [open, setOpen] = useState(false);
  // Default anchor (bottom-right of the trigger); corrected once per open by the
  // layout-measurement effect below if that would overflow the viewport — real risk on this
  // mobile-first, 2-column grid, where a left-column tile's right-anchored panel can run past
  // the left edge, and a bottom-row tile's downward panel can run past the viewport bottom.
  const [placement, setPlacement] = useState<{ horizontal: "left" | "right"; vertical: "top" | "bottom" }>({
    horizontal: "right",
    vertical: "top",
  });
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  function toggleOpen() {
    setOpen((prev) => {
      const next = !prev;
      // Reset to the default anchor in the SAME update as opening — before the measurement
      // effect below runs — so a stale flip from a previous open (now closed) can't make the
      // panel render one frame in the wrong position before self-correcting.
      if (next) setPlacement({ horizontal: "right", vertical: "top" });
      return next;
    });
  }

  useLayoutEffect(() => {
    if (!open || !panelRef.current) return;
    const rect = panelRef.current.getBoundingClientRect();
    const horizontal = rect.right > window.innerWidth ? "left" : "right";
    const vertical = rect.bottom > window.innerHeight ? "bottom" : "top";
    setPlacement((prev) => (prev.horizontal === horizontal && prev.vertical === vertical ? prev : { horizontal, vertical }));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent) {
      // Outside click: just close, don't steal focus back to the trigger — focus should follow
      // wherever the user actually clicked, same as any native dropdown.
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Opsi foto"
        disabled={pending}
        onClick={toggleOpen}
        className={cn(
          "flex size-11 items-center justify-center rounded-full bg-white/90 text-neutral-700 shadow-sm",
          "transition-opacity duration-150",
          // Hidden by default on pointer-fine (desktop), shown on hover/focus of the tile or the
          // button itself; always shown on touch, where hover has no meaning.
          "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100",
          "[@media(pointer:coarse)]:opacity-100",
          open && "opacity-100",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand",
        )}
      >
        {pending ? <Loader2 className="size-5 animate-spin" aria-hidden="true" /> : <MoreHorizontal className="size-5" aria-hidden="true" />}
      </button>
      {open && (
        <div
          ref={panelRef}
          role="menu"
          className={cn(
            "absolute z-10 w-48 rounded-lg border border-neutral-200 bg-white py-1 shadow-md",
            placement.horizontal === "right" ? "right-0" : "left-0",
            placement.vertical === "top" ? "top-full mt-1" : "bottom-full mb-1",
          )}
        >
          {items.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              type="button"
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                // Refocus the trigger before running the action — the clicked item unmounts the
                // instant the menu closes, and without this the browser drops focus to <body>.
                // Items that open a Dialog immediately re-steal focus via showModal() anyway, so
                // this is harmless there too, not just for the items that don't open one.
                triggerRef.current?.focus();
                item.onClick();
              }}
              className={cn(
                "flex min-h-11 w-full items-center gap-2 px-3 text-left text-base",
                item.danger ? "text-danger-700" : "text-neutral-900",
                "hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50",
              )}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function PhotoTile({
  productId,
  image,
  index,
  total,
  isMain,
  isThumbnail,
  reordering,
  onMoveLeft,
  onMoveRight,
}: {
  productId: string;
  image: PhotoImage;
  index: number;
  total: number;
  isMain: boolean;
  isThumbnail: boolean;
  reordering: boolean;
  onMoveLeft: () => void;
  onMoveRight: () => void;
}) {
  const router = useRouter();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [altDialogOpen, setAltDialogOpen] = useState(false);
  const [altDraft, setAltDraft] = useState(image.altText ?? "");
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Resyncs the draft with the server value whenever it actually changes for a reason OTHER
  // than this tile's own save (a concurrent edit elsewhere, or any other action on the page
  // triggering router.refresh()) — PhotoTile is keyed by image.id, which stays stable across a
  // refresh, so without this the input would keep showing a stale value. Adjusted during render
  // (React's documented "adjust state when a prop changes" pattern), not a useEffect — avoids
  // an extra render pass. This intentionally differs from the composite-key-forces-remount
  // pattern used by fabric-colors-section.tsx's ColorRow / variant-builder.tsx's
  // VariantRowEditor: a full remount here would also blow away `altDialogOpen`,
  // `deleteDialogOpen`, and `error`, which should survive an unrelated refresh.
  const [syncedAltText, setSyncedAltText] = useState(image.altText);
  if (image.altText !== syncedAltText) {
    setSyncedAltText(image.altText);
    setAltDraft(image.altText ?? "");
  }

  function makeThumbnail() {
    setError(null);
    startTransition(async () => {
      try {
        const result = await setProductThumbnailAction({ productId, imageId: image.id });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        router.refresh();
      } catch {
        setError("Gagal menjadikan foto ini sebagai thumbnail. Coba lagi.");
      }
    });
  }

  function saveAltText() {
    setError(null);
    startTransition(async () => {
      try {
        const result = await updateImageAltTextAction({ imageId: image.id, altText: altDraft || undefined });
        setAltDialogOpen(false);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        router.refresh();
      } catch {
        setAltDialogOpen(false);
        setError("Gagal menyimpan teks alternatif. Coba lagi.");
      }
    });
  }

  function handleDelete() {
    startTransition(async () => {
      try {
        const result = await deleteProductImageAction({ imageId: image.id });
        setDeleteDialogOpen(false);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        router.refresh();
      } catch {
        setDeleteDialogOpen(false);
        setError("Gagal menghapus foto. Coba lagi.");
      }
    });
  }

  const menuItems: MenuItem[] = [];
  if (!isThumbnail) {
    menuItems.push({ label: "Jadikan thumbnail", icon: <Star className="size-4" aria-hidden="true" />, onClick: makeThumbnail });
  }
  menuItems.push({
    label: "Geser ke kiri",
    icon: <ChevronLeft className="size-4" aria-hidden="true" />,
    onClick: onMoveLeft,
    disabled: index === 0 || reordering,
  });
  menuItems.push({
    label: "Geser ke kanan",
    icon: <ChevronRight className="size-4" aria-hidden="true" />,
    onClick: onMoveRight,
    disabled: index === total - 1 || reordering,
  });
  menuItems.push({
    label: "Ubah teks alternatif",
    icon: <Pencil className="size-4" aria-hidden="true" />,
    onClick: () => setAltDialogOpen(true),
  });
  menuItems.push({
    label: "Hapus",
    icon: <Trash2 className="size-4" aria-hidden="true" />,
    onClick: () => setDeleteDialogOpen(true),
    danger: true,
  });

  return (
    // No overflow-hidden here — only on the inner wrapper below, which crops just the image.
    // The dropdown menu is a sibling of that wrapper so it can render OUTSIDE the tile's own
    // bounds (opening over neighboring tiles) without getting clipped by the image's own crop.
    <div className="group relative aspect-4/5" data-testid="photo-tile">
      <div className="absolute inset-0 overflow-hidden rounded-lg border border-neutral-200 outline-1 -outline-offset-1 outline-black/5">
        <button
          type="button"
          onClick={() => setPreviewOpen(true)}
          className="absolute inset-0 block size-full cursor-zoom-in border-0 bg-transparent p-0"
        >
          <ProductImage
            src={image.urls[400]}
            srcSet={`${image.urls[400]} 400w, ${image.urls[800]} 800w, ${image.urls[1600]} 1600w`}
            sizes="(max-width: 640px) 45vw, (max-width: 1024px) 30vw, 18vw"
            alt={image.altText || "Foto produk"}
            className="size-full object-cover"
          />
        </button>
      </div>

      <div className="pointer-events-none absolute left-1.5 top-1.5 flex gap-1">
        {isThumbnail && (
          <span
            title="Thumbnail produk"
            aria-label="Thumbnail produk"
            className="flex size-6 items-center justify-center rounded-full bg-white/90 text-brand shadow-sm"
          >
            <Star className="size-3.5 fill-current" aria-hidden="true" />
          </span>
        )}
        {isMain && (
          <span className="rounded-full bg-white/90 px-2 py-0.5 text-xs font-medium text-neutral-700 shadow-sm">Utama</span>
        )}
      </div>

      <div className="absolute right-1.5 top-1.5">
        <PhotoTileMenu items={menuItems} pending={pending} />
      </div>

      {error && (
        <p role="alert" className="absolute inset-x-1.5 bottom-1.5 rounded-md bg-danger-50 px-2 py-1 text-xs text-danger-700">
          {error}
        </p>
      )}

      <Dialog open={previewOpen} onOpenChange={setPreviewOpen} title={image.altText || "Foto produk"} cancelLabel="Tutup">
        <ProductImage
          src={image.urls[1600]}
          alt={image.altText || "Foto produk"}
          loading="eager"
          className="max-h-[70vh] w-full rounded-md object-contain outline-1 -outline-offset-1 outline-black/10"
        />
      </Dialog>

      <Dialog
        open={altDialogOpen}
        onOpenChange={setAltDialogOpen}
        title="Ubah teks alternatif"
        confirmLabel="Simpan"
        onConfirm={saveAltText}
        loading={pending}
      >
        <Input
          value={altDraft}
          onChange={(event) => setAltDraft(event.target.value)}
          placeholder="Teks alternatif (opsional)"
          aria-label="Teks alternatif"
          autoFocus
        />
      </Dialog>

      <Dialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title="Hapus foto ini?"
        description="Foto yang dihapus tidak bisa dikembalikan."
        confirmLabel="Hapus"
        confirmVariant="danger"
        onConfirm={handleDelete}
        loading={pending}
      />
    </div>
  );
}
