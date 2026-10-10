"use client";

import Link from "next/link";
import { Button, Checkbox } from "@ammari/ui";
import { acceptPdpConsentAction } from "./actions";

export function ConsentForm({ next }: { next: string }) {
  return (
    <form action={acceptPdpConsentAction} className="flex w-full max-w-sm flex-col gap-4">
      <input type="hidden" name="next" value={next} />
      <Checkbox
        name="consent"
        required
        label={
          <span>
            Dengan melanjutkan, kamu menyetujui{" "}
            {/* New-tab + stopPropagation: a <Link> nested inside the Checkbox's <label> would
                otherwise also toggle the checkbox on click (any click inside a native <label>
                does that), on top of navigating — opening in a new tab also means ticking the
                box doesn't get lost by leaving this page to go read the policy. */}
            <Link
              href="/privacy-policy"
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="underline"
            >
              Kebijakan Privasi
            </Link>{" "}
            dan{" "}
            <Link
              href="/terms-of-service"
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="underline"
            >
              Syarat & Ketentuan
            </Link>{" "}
            Ammari.
          </span>
        }
      />
      <Button type="submit">Lanjutkan</Button>
    </form>
  );
}
