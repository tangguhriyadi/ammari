import { describe, expect, test } from "vitest";
import { CRON_STALE_AFTER_MINUTES, postingStatus, type PostingRunInfo } from "./posting-status";

// docs/plans/accounting.md Session 12: the posting status line on Jurnal umum and Rekonsiliasi.

const NOW = new Date("2027-01-15T03:00:00Z"); // 10.00 WIB
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
const run = (overrides: Partial<PostingRunInfo> = {}): PostingRunInfo => ({
  status: "succeeded",
  trigger: "cron",
  startedAt: minutesAgo(6),
  finishedAt: minutesAgo(5),
  ...overrides,
});

describe("postingStatus", () => {
  test("a recent successful automatic run: summary only, no warning", () => {
    const status = postingStatus(run(), minutesAgo(5), NOW);
    expect(status.summary).toMatch(/^Posting terakhir .* WIB \(otomatis\)\.$/);
    expect(status.warning).toBeNull();
  });

  test("a manual run is labelled manual", () => {
    expect(postingStatus(run({ trigger: "manual" }), minutesAgo(5), NOW).summary).toMatch(/\(manual\)\.$/);
  });

  test("a running run says since when", () => {
    const status = postingStatus(run({ status: "running", finishedAt: null }), minutesAgo(20), NOW);
    expect(status.summary).toMatch(/^Posting otomatis sedang berjalan sejak .* WIB\.$/);
    expect(status.warning).toBeNull();
  });

  test("a failed last run warns, whatever the cron did before", () => {
    const status = postingStatus(run({ status: "failed" }), minutesAgo(20), NOW);
    expect(status.summary).toMatch(/gagal/);
    expect(status.warning).toMatch(/^Posting terakhir gagal\./);
  });

  test("no successful automatic run within the hour warns that the cron is not running", () => {
    const status = postingStatus(run({ trigger: "manual" }), minutesAgo(CRON_STALE_AFTER_MINUTES + 1), NOW);
    expect(status.warning).toMatch(/^Posting otomatis belum berhasil sejak .* WIB\./);
    expect(postingStatus(run(), minutesAgo(CRON_STALE_AFTER_MINUTES), NOW).warning).toBeNull();
  });

  test("never posted, and a cron that never ran", () => {
    expect(postingStatus(null, null, NOW)).toEqual({
      summary: "Belum pernah posting.",
      warning: "Posting otomatis belum pernah berjalan. Jurnal tetap bisa dibuat dengan Posting sekarang; minta pemilik menyalakan layanan cron.",
    });
  });

  test("no em dash in any text", () => {
    const texts = [postingStatus(null, null, NOW), postingStatus(run({ status: "failed" }), null, NOW), postingStatus(run(), minutesAgo(200), NOW)];
    for (const { summary, warning } of texts) expect(`${summary} ${warning ?? ""}`).not.toMatch(/—/);
  });
});
