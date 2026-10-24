"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useTransition,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Check } from "lucide-react";
import { Button, Card, Dialog, cn, useToast } from "@ammari/ui";
import {
  buildStepItems,
  productStepHref,
  stepAt,
  stepDefinition,
  stepIndex,
  stepPositionLabel,
  PRODUCT_STEP_KEYS,
  type ProductStepCompletion,
  type ProductStepItem,
  type ProductStepKey,
} from "@/lib/products/stepper";

/** What a section on the current step tells the stepper: whether it holds unsaved changes, and
 * how to save them ("Lanjut" in create mode). `save` resolves false when nothing may move on
 * (a validation or server error, already shown by the section itself). */
export interface StepSectionEntry {
  dirty: boolean;
  save: () => Promise<boolean>;
}

interface StepperContextValue {
  register: (id: string, entry: RefObject<StepSectionEntry>) => () => void;
  /** Moves to `href`, asking first when a section has unsaved changes. */
  navigate: (href: string) => void;
  /** Called by the Varian step once variants were added, before the refreshed `hasVariants`
   * prop arrives, so an immediate "Lanjut" isn't refused for a product that has some now. */
  reportVariantsAdded: () => void;
}

const StepperContext = createContext<StepperContextValue | null>(null);

/** Registers a section of the current step with the surrounding ProductStepper. A no-op outside
 * one, so the sections still work on their own. */
export function useStepSection(dirty: boolean, save: () => Promise<boolean>): void {
  const stepper = useContext(StepperContext);
  const id = useId();
  const entryRef = useRef<StepSectionEntry>({ dirty, save });
  useEffect(() => {
    entryRef.current = { dirty, save };
  });
  useEffect(() => stepper?.register(id, entryRef), [stepper, id]);
}

/** For AddVariantForm: see StepperContextValue.reportVariantsAdded. A no-op outside a stepper. */
export function useReportVariantsAdded(): () => void {
  return useContext(StepperContext)?.reportVariantsAdded ?? noop;
}

function noop() {}

// Set right before a navigation that lands on a freshly mounted stepper (a different route:
// /products/new -> /products/[id]/setup, or "Selesai" -> /products/[id]), so the new page moves
// focus to its step content like a same-route step switch does. Module state survives client
// navigations.
let focusStepOnMount = false;

/** Call before router.push to another stepper page (see focusStepOnMount). */
export function focusStepAfterNavigation(): void {
  focusStepOnMount = true;
}

/** Step navigation for links inside a section (e.g. the Toko online card's "Buka bagian Foto"),
 * with the same unsaved-changes check as the step bar. Null outside a stepper. */
export function useStepNavigation(): ((href: string) => void) | null {
  return useContext(StepperContext)?.navigate ?? null;
}

/** Marks a link the page-wide useUnsavedChangesGuard must leave alone: the stepper asks with its
 * own dialog instead of window.confirm. */
export const SKIP_UNSAVED_GUARD = { "data-skip-unsaved-guard": "" } as const;

export type ProductStepperProps = {
  current: ProductStepKey;
  hasVariants: boolean;
  children: ReactNode;
} & (
  | { mode: "create"; productId: string | null; reached: ProductStepKey }
  | { mode: "edit"; productId: string; completion: ProductStepCompletion }
);

export function ProductStepper(props: ProductStepperProps) {
  const { current, hasVariants, children, mode, productId } = props;
  const router = useRouter();
  const toast = useToast();
  const sections = useRef(new Map<string, RefObject<StepSectionEntry>>());
  const [confirmHref, setConfirmHref] = useState<string | null>(null);
  const [footerError, setFooterError] = useState<{ step: ProductStepKey; message: string } | null>(null);
  const [navigating, startNavigation] = useTransition();
  const contentRef = useRef<HTMLDivElement>(null);
  const shownStep = useRef(current);
  const variantsAdded = useRef(false);

  const reached = props.mode === "create" ? props.reached : null;
  const completion = props.mode === "edit" ? props.completion : null;
  const items = useMemo(() => {
    if (completion !== null && productId !== null) return buildStepItems({ mode: "edit", productId, current, completion });
    return buildStepItems({ mode: "create", productId, current, reached: reached ?? current });
  }, [productId, current, reached, completion]);

  useEffect(() => {
    if (!focusStepOnMount) return;
    focusStepOnMount = false;
    if (!contentRef.current?.contains(document.activeElement)) contentRef.current?.focus({ preventScroll: true });
  }, []);

  // A step switch is a navigation to the same route, so this component stays mounted: move focus
  // to the new step's content so keyboard and screen reader users start there.
  useEffect(() => {
    if (shownStep.current === current) return;
    shownStep.current = current;
    // A section that already took focus on arrival (the Foto heading) keeps it.
    if (contentRef.current?.contains(document.activeElement)) return;
    contentRef.current?.focus({ preventScroll: true });
  }, [current]);

  const isDirty = useCallback(() => [...sections.current.values()].some((entry) => entry.current.dirty), []);

  const navigate = useCallback(
    (href: string) => {
      if (isDirty()) {
        setConfirmHref(href);
        return;
      }
      startNavigation(() => router.push(href));
    },
    [isDirty, router],
  );

  const contextValue = useMemo<StepperContextValue>(
    () => ({
      register: (id, entry) => {
        sections.current.set(id, entry);
        return () => {
          sections.current.delete(id);
        };
      },
      navigate,
      // Variants can be deactivated but never deleted, so this never needs resetting.
      reportVariantsAdded: () => {
        variantsAdded.current = true;
        setFooterError(null);
      },
    }),
    [navigate],
  );

  const index = stepIndex(current);
  const isLast = index === PRODUCT_STEP_KEYS.length - 1;
  const step = stepDefinition(current);

  function hrefFor(key: ProductStepKey): string | null {
    if (productId === null) return null;
    return mode === "create" ? productStepHref(productId, key, "create", reached ?? undefined) : productStepHref(productId, key, "edit");
  }

  const backHref = index > 0 ? hrefFor(stepAt(index - 1)) : null;
  const forwardHref = productId === null ? null : isLast ? `/products/${productId}` : hrefFor(stepAt(index + 1));

  function saveAndContinue() {
    if (!forwardHref) return;
    setFooterError(null);
    startNavigation(async () => {
      let savedAny = false;
      // Registration (tree) order: ProductForm saves before DiscountSection, which checks against
      // the saved base price. A later failure leaves earlier sections saved, each shown as such.
      for (const entry of [...sections.current.values()]) {
        if (!entry.current.dirty) continue;
        if (!(await entry.current.save())) return;
        savedAny = true;
      }
      if (current === "varian" && !hasVariants && !savedAny && !variantsAdded.current) {
        setFooterError({ step: current, message: "Tambah minimal satu varian sebelum lanjut." });
        return;
      }
      if (isLast) {
        toast.success("Produk berhasil disimpan");
        focusStepAfterNavigation();
      }
      router.push(forwardHref);
    });
  }

  function confirmLeave() {
    const href = confirmHref;
    setConfirmHref(null);
    if (href) startNavigation(() => router.push(href));
  }

  const showFooter = productId !== null;
  const visibleError = footerError?.step === current && !hasVariants ? footerError.message : null;

  return (
    <StepperContext.Provider value={contextValue}>
      {/* On phones the Foto step's unsaved-photos bar is fixed above the bottom nav; the extra
          space keeps this card's footer (Lanjut) from ending up underneath it. */}
      <Card className={cn("p-0", current === "foto" && "mb-24 sm:mb-0")}>
        <div className="px-4 py-4 lg:px-6">
          <StepIndicator items={items} current={current} onNavigate={navigate} />
        </div>
        <div className="border-t border-neutral-200" role="presentation" />
        <div
          ref={contentRef}
          tabIndex={-1}
          role="region"
          aria-label={stepPositionLabel(current)}
          data-testid="product-step-content"
          data-step={current}
          className="scroll-mt-20 px-4 py-6 focus:outline-none lg:px-6"
        >
          {children}
        </div>
        {showFooter && (
          <div className="flex flex-col gap-2 border-t border-neutral-200 px-4 py-3 lg:px-6" data-testid="product-step-footer">
            {visibleError && (
              <p role="alert" className="text-sm text-danger-700">
                {visibleError}
              </p>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                {backHref && (
                  <Button type="button" variant="secondary" onClick={() => navigate(backHref)} disabled={navigating}>
                    Kembali
                  </Button>
                )}
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                {mode === "create" && step.skippable && forwardHref && (
                  <Button type="button" variant="ghost" onClick={() => navigate(forwardHref)} disabled={navigating}>
                    Lewati
                  </Button>
                )}
                {mode === "create" && forwardHref && (
                  <Button type="button" onClick={saveAndContinue} loading={navigating}>
                    {isLast ? "Selesai" : "Lanjut"}
                  </Button>
                )}
                {mode === "edit" && !isLast && forwardHref && (
                  <Button type="button" onClick={() => navigate(forwardHref)} disabled={navigating}>
                    Lanjut
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}
      </Card>

      <Dialog
        open={confirmHref !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmHref(null);
        }}
        title="Ada perubahan yang belum disimpan"
        description="Perubahan di langkah ini akan hilang kalau Anda pindah langkah sekarang."
        cancelLabel="Tetap di sini"
        confirmLabel="Buang perubahan"
        confirmVariant="danger"
        onConfirm={confirmLeave}
      />
    </StepperContext.Provider>
  );
}

const STATUS_TEXT: Record<ProductStepItem["status"], string> = {
  current: "",
  done: ", selesai",
  upcoming: "",
};

export function StepIndicator({
  items,
  current,
  onNavigate,
}: {
  items: ProductStepItem[];
  current: ProductStepKey;
  onNavigate: (href: string) => void;
}) {
  return (
    <nav aria-label="Langkah produk">
      <ol className="flex items-start">
        {items.map((item, index) => {
          const isLastItem = index === items.length - 1;
          return (
            <li key={item.key} className={cn("flex min-w-0 items-start", !isLastItem && "flex-1")}>
              <StepMarker item={item} onNavigate={onNavigate} />
              {!isLastItem && (
                <span
                  aria-hidden="true"
                  className={cn("mx-1.5 mt-4 h-px min-w-3 flex-1 lg:mx-3", item.status === "done" ? "bg-brand" : "bg-neutral-200")}
                />
              )}
            </li>
          );
        })}
      </ol>
      <p className="mt-3 text-sm font-medium text-neutral-900 lg:hidden" aria-hidden="true" data-testid="step-position">
        {stepPositionLabel(current)}
      </p>
    </nav>
  );
}

function StepMarker({ item, onNavigate }: { item: ProductStepItem; onNavigate: (href: string) => void }) {
  const circle = (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold tabular-nums",
        item.status === "current" && "bg-brand text-brand-foreground",
        item.status === "done" && "border-2 border-brand bg-white text-brand",
        item.status === "upcoming" && "bg-neutral-100 text-neutral-600",
      )}
    >
      {item.status === "done" ? <Check className="size-4" strokeWidth={3} /> : item.number}
    </span>
  );
  const text = (
    <span className="sr-only lg:not-sr-only lg:flex lg:min-w-0 lg:flex-col lg:pt-1.5">
      <span
        className={cn(
          "text-sm font-semibold leading-5",
          item.status === "upcoming" ? "text-neutral-600" : "text-neutral-900",
          item.href && item.status !== "current" && "group-hover:underline",
        )}
      >
        {item.title}
        {/* Read right after the title: "Info produk, selesai". */}
        {STATUS_TEXT[item.status] && <span className="sr-only">{STATUS_TEXT[item.status]}</span>}
        {item.href === null && item.status !== "current" && (
          <span className="sr-only"> (terkunci, selesaikan langkah sebelumnya dulu)</span>
        )}
      </span>
      <span className={cn("text-xs leading-4", item.status === "upcoming" ? "text-neutral-600" : "text-neutral-700")}>
        {item.description}
      </span>
    </span>
  );
  const layout = "flex min-w-0 items-start gap-3";

  if (item.status === "current") {
    return (
      <span aria-current="step" className={layout} data-testid={`step-${item.key}`} data-status="current">
        {circle}
        {text}
      </span>
    );
  }

  if (item.href === null) {
    return (
      <span className={layout} data-testid={`step-${item.key}`} data-status={item.status} data-locked="">
        {circle}
        {text}
      </span>
    );
  }

  const href = item.href;
  return (
    <Link
      href={href}
      {...SKIP_UNSAVED_GUARD}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
        event.preventDefault();
        onNavigate(href);
      }}
      className={cn(
        layout,
        // A 44px hit area around the 32px circle on phones without moving the layout.
        "group -m-1.5 rounded-md p-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand",
      )}
      data-testid={`step-${item.key}`}
      data-status={item.status}
    >
      {circle}
      {text}
    </Link>
  );
}
