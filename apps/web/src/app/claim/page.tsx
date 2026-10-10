import { Button, Input, Label } from "@ammari/ui";
import { enterClaimCodeAction } from "./actions";

export default async function ClaimEntryPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-neutral-50 px-4 py-10">
      <h1 className="font-serif text-2xl font-light text-brand">Masukkan kode voucher</h1>
      <p className="max-w-sm text-center text-sm text-neutral-700">
        Ketik kode yang tertulis di kartu terima kasihmu.
      </p>
      <form action={enterClaimCodeAction} className="flex w-full max-w-sm flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="code">Kode voucher</Label>
          <Input
            id="code"
            name="code"
            required
            autoComplete="off"
            autoCapitalize="characters"
            placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XX"
            className="text-center tracking-wide uppercase"
          />
        </div>
        {error && (
          <p role="alert" className="text-sm text-danger-700">
            Masukkan kode voucher terlebih dahulu.
          </p>
        )}
        <Button type="submit">Lanjutkan</Button>
      </form>
    </div>
  );
}
