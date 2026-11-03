"use client";

import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Label } from "@ammari/ui";
import { completeProfileAction, type CompleteProfileState } from "./actions";

const initialState: CompleteProfileState = {};

export function CompleteProfileForm({ name, phone }: { name: string; phone: string | null }) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(completeProfileAction, initialState);

  return (
    <form action={formAction} className="flex w-full flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label className="text-[15px]" htmlFor="name">Nama</Label>
        <Input id="name" name="name" type="text" required defaultValue={name} autoComplete="name" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label className="text-[15px]" htmlFor="phone">Nomor HP</Label>
        <Input
          id="phone"
          name="phone"
          type="tel"
          defaultValue={phone ?? ""}
          autoComplete="tel"
          placeholder="+6281234567890"
        />
      </div>
      {state.error && (
        <p role="alert" className="text-[15px] text-danger-700">
          {state.error}
        </p>
      )}
      <div className="flex gap-3">
        <Button className="text-sm" type="submit" loading={pending}>
          Simpan
        </Button>
        {/* Skipping just returns to /account — no write, no server round-trip needed. */}
        <Button className="text-sm" type="button" variant="ghost" onClick={() => router.push("/account")}>
          Lewati
        </Button>
      </div>
    </form>
  );
}
