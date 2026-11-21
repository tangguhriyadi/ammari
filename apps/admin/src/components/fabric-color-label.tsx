import { ColorSwatch } from "@ammari/ui";

/** A fabric colour as shown next to a purchase line, receipt line or defect row
 * (docs/plans/fabric-colour-stock.md §4.2): swatch + name, or "Tanpa warna" for a colourless line.
 * `legacy` adds "(data lama)": a colourless line of a fabric that has colours today, i.e. one
 * ordered before its colours existed. Server-safe (no hooks), usable from server and client. */
export function FabricColorLabel({
  name,
  hex,
  legacy = false,
  className = "",
  testId = "fabric-color",
}: {
  name: string | null;
  hex: string | null;
  legacy?: boolean;
  className?: string;
  testId?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-sm text-neutral-700 ${className}`} data-testid={testId}>
      {name !== null ? (
        <>
          <ColorSwatch hex={hex} className="size-4" />
          {name}
        </>
      ) : (
        <span className="text-neutral-600">{legacy ? "Tanpa warna (data lama)" : "Tanpa warna"}</span>
      )}
    </span>
  );
}
