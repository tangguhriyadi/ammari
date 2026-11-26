import { redirect } from "next/navigation";

// The Akuntansi group has no page of its own; its first report is Jurnal umum.
export default function AccountingPage() {
  redirect("/accounting/journal");
}
