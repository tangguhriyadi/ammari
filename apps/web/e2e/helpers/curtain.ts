import type { Locator } from "@playwright/test";

/** Starts recording a Curtain panel's (components/curtain.tsx) lifecycle for the panel a
 * disclosure button controls: every `data-state` it passes through, whether it was removed, and
 * its height on every animation frame. The panel need not exist yet. Read it with
 * `readCurtainLog`. */
export async function recordCurtain(trigger: Locator): Promise<void> {
  const panelId = await trigger.getAttribute("aria-controls");
  if (!panelId) throw new Error("trigger has no aria-controls");
  await trigger.page().evaluate((id) => {
    const log = { states: [] as string[], heights: [] as number[] };
    (window as unknown as { __curtainLog: typeof log }).__curtainLog = log;
    let last: string | null = null;
    function sample() {
      const panel = document.getElementById(id);
      const state = panel?.getAttribute("data-state") ?? "removed";
      if (state !== last) log.states.push(state);
      last = state;
      if (panel) log.heights.push(panel.getBoundingClientRect().height);
      requestAnimationFrame(sample);
    }
    // A MutationObserver catches a state that lives for less than a frame (e.g. "entering").
    new MutationObserver(() => {
      const state = document.getElementById(id)?.getAttribute("data-state") ?? "removed";
      if (state !== last) log.states.push(state);
      last = state;
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-state"] });
    sample();
  }, panelId);
}

export async function readCurtainLog(trigger: Locator): Promise<{ states: string[]; heights: number[] }> {
  return trigger.page().evaluate(() => (window as unknown as { __curtainLog: { states: string[]; heights: number[] } }).__curtainLog);
}

/** True when some recorded height sat strictly between closed and the final height, i.e. the
 * panel really animated rather than jumping. */
export function animatedBetween(heights: number[], to: number): boolean {
  return heights.some((height) => height > 1 && height < to - 1);
}
