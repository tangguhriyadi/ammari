"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "@ammari/ui";
import { Curtain } from "@/components/curtain";
import type { PickedArea } from "@/lib/checkout/form";
import { AREA_SEARCH_MAX_LENGTH, AREA_SEARCH_MIN_LENGTH } from "@/lib/shipping/messages";
import { FIELD_INPUT_CLASS, FieldError, fieldErrorId } from "./fields";

// "Kecamatan atau kode pos" (docs/plans/cart-checkout.md §4.3, §4.5.1, docs/design/storefront.md
// §7): one search field over GET /api/shipping/areas (flag-gated, same-origin, rate limited on the
// server). Searches after 3 characters and a 300 ms pause; every keystroke aborts the request
// before it, so a slow answer never overwrites a newer one. The result list unrolls with the
// storefront's Curtain. The chosen area shows read-only as "Kecamatan, Kota, Provinsi 12345" with
// "Ganti". Only our own shipping_areas id leaves the browser (in the checkout submit).
//
// ARIA 1.2 combobox: the input owns a listbox (`aria-controls`, `aria-expanded`), the highlighted
// option is `aria-activedescendant`, Arrow keys move, Enter picks, Escape closes.

const DEBOUNCE_MS = 300;
const SEARCH_FAILED_MESSAGE = "Pencarian alamat belum bisa dipakai. Coba lagi sebentar lagi.";
const NO_RESULTS_MESSAGE = "Tidak ditemukan. Coba nama kecamatan lain atau kode pos.";

type SearchState =
  | { status: "idle" }
  /** `previous`: the last results, kept on screen while a refined search runs (no flicker). */
  | { status: "loading"; previous: PickedArea[] }
  | { status: "done"; areas: PickedArea[] }
  | { status: "error"; message: string };

interface AreaComboboxProps {
  id: string;
  value: PickedArea | null;
  onChange: (area: PickedArea | null) => void;
  error?: string;
}

function isAreaList(value: unknown): value is { areas: PickedArea[] } {
  if (typeof value !== "object" || value === null || !Array.isArray((value as { areas?: unknown }).areas)) return false;
  return (value as { areas: unknown[] }).areas.every(
    (area) =>
      typeof area === "object" &&
      area !== null &&
      typeof (area as PickedArea).id === "string" &&
      typeof (area as PickedArea).label === "string" &&
      typeof (area as PickedArea).hasPostalCode === "boolean",
  );
}

export function AreaCombobox({ id, value, onChange, error }: AreaComboboxProps) {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<SearchState>({ status: "idle" });
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const changeRef = useRef<HTMLButtonElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const focusAfterRef = useRef<"input" | "change" | null>(null);

  const listboxId = `${id}-listbox`;
  const statusId = `${id}-status`;
  const errorId = error ? fieldErrorId(id) : null;

  // Stop a pending search when the field goes away (a successful order navigates off the page).
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      abortRef.current?.abort();
    },
    [],
  );

  // Focus follows the swap between the search input and the chosen-area line ("Ganti" and a pick),
  // so a keyboard user never lands on <body>.
  useEffect(() => {
    const target = focusAfterRef.current;
    focusAfterRef.current = null;
    if (target === "input") inputRef.current?.focus();
    if (target === "change") changeRef.current?.focus();
  }, [value]);

  async function runSearch(text: string) {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setSearch((current) => ({ status: "loading", previous: current.status === "done" ? current.areas : current.status === "loading" ? current.previous : [] }));
    try {
      const response = await fetch(`/api/shipping/areas?q=${encodeURIComponent(text)}`, { signal: controller.signal, cache: "no-store" });
      const body: unknown = await response.json().catch(() => null);
      if (controller.signal.aborted) return;
      if (response.ok && isAreaList(body)) {
        setSearch({ status: "done", areas: body.areas });
        setActiveIndex(body.areas.length > 0 ? 0 : -1);
        return;
      }
      const message = typeof (body as { error?: unknown } | null)?.error === "string" ? (body as { error: string }).error : SEARCH_FAILED_MESSAGE;
      // The route's own Indonesian message is shown; the status is kept for diagnosis.
      if (!response.ok && response.status !== 400 && response.status !== 429) console.warn("[checkout] area search answered", response.status);
      else if (response.ok) console.error("[checkout] area search answered an unexpected body");
      setSearch({ status: "error", message });
    } catch (fetchError) {
      if (controller.signal.aborted) return;
      console.error("[checkout] area search request failed", fetchError instanceof Error ? fetchError.name : "unknown");
      setSearch({ status: "error", message: SEARCH_FAILED_MESSAGE });
    }
  }

  function handleInput(next: string) {
    const text = next.slice(0, AREA_SEARCH_MAX_LENGTH);
    setQuery(text);
    if (timerRef.current) clearTimeout(timerRef.current);
    abortRef.current?.abort();
    const trimmed = text.trim();
    if (trimmed.length < AREA_SEARCH_MIN_LENGTH) {
      setSearch({ status: "idle" });
      setOpen(false);
      setActiveIndex(-1);
      return;
    }
    setOpen(true);
    timerRef.current = setTimeout(() => void runSearch(trimmed), DEBOUNCE_MS);
  }

  function pick(area: PickedArea) {
    if (timerRef.current) clearTimeout(timerRef.current);
    abortRef.current?.abort();
    setOpen(false);
    setActiveIndex(-1);
    focusAfterRef.current = "change";
    onChange(area);
  }

  function change() {
    setQuery("");
    setSearch({ status: "idle" });
    setOpen(false);
    focusAfterRef.current = "input";
    onChange(null);
  }

  const areas = search.status === "done" ? search.areas : search.status === "loading" ? search.previous : [];
  const listOpen = open && areas.length > 0 && (search.status === "done" || search.status === "loading");

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" && areas.length > 0) {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((index) => (index + 1) % areas.length);
    } else if (event.key === "ArrowUp" && areas.length > 0) {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((index) => (index <= 0 ? areas.length - 1 : index - 1));
    } else if (event.key === "Enter") {
      // Never submit the checkout from the search field: Enter picks the highlighted area, or
      // does nothing.
      event.preventDefault();
      const area = listOpen ? areas[activeIndex] : undefined;
      if (area) pick(area);
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
    }
  }

  if (value) {
    return (
      <div className="flex flex-col gap-1.5">
        <span id={`${id}-label`} className="text-[13px] text-ink">
          Kecamatan atau kode pos
        </span>
        <div className="flex min-h-12 items-center justify-between gap-4 border border-line-strong bg-surface px-3 py-2" aria-labelledby={`${id}-label`} role="group">
          <p className="text-[15px] text-ink" data-testid="picked-area">
            {value.label}
          </p>
          <button
            ref={changeRef}
            type="button"
            onClick={change}
            aria-label={`Ganti kecamatan, sekarang ${value.label}`}
            className="flex min-h-11 shrink-0 items-center text-xs font-medium tracking-[0.16em] text-ink uppercase underline underline-offset-4"
          >
            Ganti
          </button>
        </div>
        {error && errorId && <FieldError id={errorId}>{error}</FieldError>}
      </div>
    );
  }

  const statusText =
    search.status === "loading"
      ? "Mencari..."
      : search.status === "error"
        ? search.message
        : search.status === "done" && areas.length === 0
          ? NO_RESULTS_MESSAGE
          : search.status === "done"
            ? `${areas.length} hasil. Pilih dengan panah atas dan bawah.`
            : "";

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] text-ink">
        Kecamatan atau kode pos
      </label>
      <input
        ref={inputRef}
        id={id}
        type="text"
        role="combobox"
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="search"
        placeholder="Ketik nama kecamatan atau kode pos"
        value={query}
        maxLength={AREA_SEARCH_MAX_LENGTH}
        onChange={(event) => handleInput(event.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={() => {
          if (search.status === "done" && areas.length > 0) setOpen(true);
        }}
        // A pointer pick happens on mousedown (which keeps focus here), so closing on blur never
        // loses a pick; tabbing or clicking away closes the list.
        onBlur={() => setOpen(false)}
        aria-expanded={listOpen}
        aria-controls={listOpen ? listboxId : undefined}
        aria-busy={search.status === "loading" || undefined}
        aria-autocomplete="list"
        aria-activedescendant={listOpen && activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={[statusId, errorId].filter(Boolean).join(" ")}
        className={FIELD_INPUT_CLASS}
      />
      {/* Always mounted, so a screen reader hears each change. The result count is for screen
          readers only; loading, "not found" and errors show. */}
      <p
        id={statusId}
        role="status"
        className={cn("text-xs", search.status === "error" ? "text-error" : "text-ink-muted", (!statusText || listOpen) && "sr-only")}
      >
        {statusText}
      </p>
      <Curtain open={listOpen}>
        <ul id={listboxId} role="listbox" aria-label="Pilihan kecamatan" className="border border-t-0 border-line-strong bg-bg">
          {areas.map((area, index) => (
            <li
              key={area.id}
              id={`${listboxId}-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              // Pointer pick on mousedown, before the input's blur closes the list.
              onMouseDown={(event) => {
                event.preventDefault();
                pick(area);
              }}
              onMouseEnter={() => setActiveIndex(index)}
              className={cn("flex min-h-11 cursor-pointer items-center px-3 py-2 text-sm text-ink", index === activeIndex && "bg-surface")}
            >
              {area.label}
            </li>
          ))}
        </ul>
      </Curtain>
      {error && errorId && <FieldError id={errorId}>{error}</FieldError>}
    </div>
  );
}
