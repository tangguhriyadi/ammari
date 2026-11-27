import { formatRupiah } from "@ammari/ui/lib";
import type { PeriodRow } from "./periods";

/** What closing will post (Session 11): the PPh final accrual (D-20) and, for December, the year end. */
export function closePostingsSummary(row: Pick<PeriodRow, "pphFinal" | "closesYear" | "label">): string[] {
  const lines: string[] = [];
  const pph = row.pphFinal;
  if (pph?.kind === "accrual") {
    lines.push(
      pph.amount === 0
        ? pph.monthBase < 0
          ? `PPh final: tidak ada. Omzet bersih bulan ini negatif (${formatRupiah(pph.monthBase)}); PPh bulan sebelumnya tidak dikurangi.`
          : `PPh final: tidak ada (omzet bersih tahun berjalan ${formatRupiah(pph.ytdAfter)}, bebas pajak ${formatRupiah(pph.exemption)}).`
        : `PPh final yang dibukukan saat tutup: ${formatRupiah(pph.amount)} (${String(pph.rateBps / 100).replace(".", ",")}% x ${formatRupiah(pph.taxable)}; omzet bersih bulan ini ${formatRupiah(pph.monthBase)}).`,
    );
  }
  if (row.closesYear) lines.push(`Menutup ${row.label} juga membukukan jurnal penutup tahun: laba rugi tahun ini ke Saldo laba, Prive ke Modal pemilik.`);
  return lines;
}

