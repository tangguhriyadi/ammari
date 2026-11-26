export function expenseUsageText(expenseCount: number): string {
  return expenseCount === 0 ? "Belum dipakai" : `Dipakai ${expenseCount} biaya`;
}
