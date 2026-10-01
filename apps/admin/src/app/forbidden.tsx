import Link from "next/link";
import { ShieldAlert } from "lucide-react";

export default function Forbidden() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-neutral-50 px-4 text-center">
      <ShieldAlert aria-hidden="true" className="size-12 text-danger-700" />
      <h1 className="font-serif text-3xl font-light text-neutral-900">Akses ditolak</h1>
      <p className="max-w-sm text-base text-neutral-600">
        Kamu tidak memiliki izin untuk mengakses halaman ini. Hubungi admin jika menurutmu ini
        keliru.
      </p>
      <Link
        href="/"
        className="inline-flex min-h-11 items-center rounded-md bg-brand px-4 text-base font-medium text-white"
      >
        Kembali ke Ringkasan
      </Link>
    </main>
  );
}
