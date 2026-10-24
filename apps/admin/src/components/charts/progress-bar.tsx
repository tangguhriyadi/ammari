/**
 * Progress toward a target with an optional marker where the pace says it should be (§2.3, D4;
 * §4.1 ProgressBar). The fill is clamped at 100%; the marker is a black line, explained in words
 * by the caller, so colour is not the only signal.
 */
export function ProgressBar({
  valueBps,
  markerBps,
  label,
  valueText,
}: {
  /** 0..10000 (clamped). */
  valueBps: number;
  /** 0..10000, or none. */
  markerBps?: number;
  label: string;
  valueText: string;
}) {
  const clamp = (bps: number) => Math.min(Math.max(bps, 0), 10_000);
  const value = clamp(valueBps);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.floor(value / 100)}
      aria-valuetext={valueText}
      className="relative h-3 rounded-full bg-neutral-200"
    >
      <div className="h-full rounded-full bg-brand" style={{ width: `${value / 100}%` }} />
      {markerBps !== undefined && (
        <div aria-hidden="true" className="absolute -top-1 h-5 w-0.5 -translate-x-1/2 bg-black" style={{ left: `${clamp(markerBps) / 100}%` }} />
      )}
    </div>
  );
}
