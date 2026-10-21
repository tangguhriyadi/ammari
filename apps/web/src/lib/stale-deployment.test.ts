// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { STALE_PAGE_MESSAGE, failedCallMessage, isStaleDeploymentError, scheduleStaleReload } from "./stale-deployment";

class UnrecognizedActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnrecognizedActionError";
  }
}

describe("isStaleDeploymentError", () => {
  test("a server action or chunk from the previous build", () => {
    expect(isStaleDeploymentError(new UnrecognizedActionError('Server Action "abc" was not found on the server.'))).toBe(true);
    expect(isStaleDeploymentError(Object.assign(new Error("Loading chunk 123 failed."), { name: "ChunkLoadError" }))).toBe(true);
    expect(isStaleDeploymentError(new Error("Failed to find Server Action. This request might be from an older or newer deployment."))).toBe(true);
  });
  test("anything else is not", () => {
    expect(isStaleDeploymentError(new Error("fetch failed"))).toBe(false);
    expect(isStaleDeploymentError(new TypeError("Failed to fetch"))).toBe(false);
    expect(isStaleDeploymentError("Server Action was not found")).toBe(false);
    expect(isStaleDeploymentError(null)).toBe(false);
  });
});

describe("reloading a stale page", () => {
  const reload = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
    Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, reload } });
  });
  afterEach(() => {
    vi.useRealTimers();
    reload.mockReset();
  });

  test("a stale call shows the message and reloads once; a page still stale right after does not loop", () => {
    expect(failedCallMessage(new UnrecognizedActionError("x"), "Koneksi terputus.")).toBe(STALE_PAGE_MESSAGE);
    vi.advanceTimersByTime(1_500);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(scheduleStaleReload()).toBe(false);
    vi.advanceTimersByTime(5_000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("any other failure keeps the call site's own message and never reloads", () => {
    expect(failedCallMessage(new Error("offline"), "Koneksi terputus.")).toBe("Koneksi terputus.");
    vi.advanceTimersByTime(5_000);
    expect(reload).not.toHaveBeenCalled();
  });
});
