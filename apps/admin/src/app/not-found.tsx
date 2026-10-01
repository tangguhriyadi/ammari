import Link from "next/link";
import { Compass } from "lucide-react";

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-neutral-50 px-4 text-center">
      <Compass aria-hidden="true" className="size-12 text-neutral-500" />
      <h1 className="font-serif text-3xl font-light text-neutral-900">Halaman tidak ditemukan</h1>
      <p className="max-w-sm text-base text-neutral-600">
        Halaman yang kamu cari tidak ada atau sudah dipindahkan.
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
