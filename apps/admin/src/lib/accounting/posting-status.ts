import { formatDateTime } from "@ammari/ui/lib";

// What Jurnal umum and Rekonsiliasi say about posting (docs/plans/accounting.md §2, Session 12): the
// last run (manual or automatic, running, succeeded or failed) and whether the automatic posting
// (the cron, every 15 minutes) is actually running. Pure, so the wording is tested.

export interface PostingRunInfo {
  status: "running" | "succeeded" | "failed";
  trigger: "cron" | "manual";
  startedAt: Date;
  finishedAt: Date | null;
}

export interface PostingStatus {
  /** One sentence for the page description. */
  summary: string;
  /** A warning to show on its own, or null. */
  warning: string | null;
}

/** The cron runs every 15 minutes; an hour without a successful automatic run means it is not
 * running (not configured, web down, or every run failing). */
export const CRON_STALE_AFTER_MINUTES = 60;

const TRIGGER_LABEL = { cron: "otomatis", manual: "manual" } as const;

export function postingStatus(lastRun: PostingRunInfo | null, lastCronSuccessAt: Date | null, now: Date): PostingStatus {
  let summary: string;
  let warning: string | null = null;
  if (!lastRun) {
    summary = "Belum pernah posting.";
  } else if (lastRun.status === "running") {
    summary = `Posting ${TRIGGER_LABEL[lastRun.trigger]} sedang berjalan sejak ${formatDateTime(lastRun.startedAt)} WIB.`;
  } else if (lastRun.status === "failed") {
    summary = `Posting terakhir (${TRIGGER_LABEL[lastRun.trigger]}) gagal, ${formatDateTime(lastRun.finishedAt ?? lastRun.startedAt)} WIB.`;
    warning = "Posting terakhir gagal. Jalankan Posting sekarang; jika gagal lagi, periksa daftar yang perlu dicek atau hubungi pemilik.";
  } else {
    summary = `Posting terakhir ${formatDateTime(lastRun.finishedAt ?? lastRun.startedAt)} WIB (${TRIGGER_LABEL[lastRun.trigger]}).`;
  }

  const cronStale = !lastCronSuccessAt || now.getTime() - lastCronSuccessAt.getTime() > CRON_STALE_AFTER_MINUTES * 60_000;
  if (cronStale && warning === null) {
    warning = lastCronSuccessAt
      ? `Posting otomatis belum berhasil sejak ${formatDateTime(lastCronSuccessAt)} WIB. Jurnal tetap bisa dibuat dengan Posting sekarang; minta pemilik memeriksa layanan cron.`
      : "Posting otomatis belum pernah berjalan. Jurnal tetap bisa dibuat dengan Posting sekarang; minta pemilik menyalakan layanan cron.";
  }
  return { summary, warning };
}
