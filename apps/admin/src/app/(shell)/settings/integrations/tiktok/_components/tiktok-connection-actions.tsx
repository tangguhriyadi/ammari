"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Dialog, useToast } from "@ammari/ui";
import { TIKTOK_DISCONNECTED_MESSAGE } from "@/lib/integrations/tiktok-messages";
import { disconnectTikTokAction, startTikTokConnectAction } from "../actions";

// Hubungkan / Hubungkan ulang / Putuskan (docs/plans/tiktok-shop-integration.md §7.3). The server
// re-checks integrations.manage on every action; this only drives the buttons. "Hubungkan" sends the
// browser to TikTok's authorize page, which comes back to the callback route.

export function TikTokConnectionActions({ mode, canDisconnect, disabled }: { mode: "connect" | "reconnect"; canDisconnect: boolean; disabled: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [connecting, startConnect] = useTransition();
  const [disconnecting, startDisconnect] = useTransition();
  const [leaving, setLeaving] = useState(false);

  // Coming back from TikTok with the Back button restores this page from the bfcache with
  // `leaving` still set; clear it so the buttons work again.
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) setLeaving(false);
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  function connect() {
    setError(null);
    startConnect(async () => {
      let result: Awaited<ReturnType<typeof startTikTokConnectAction>>;
      try {
        result = await startTikTokConnectAction();
      } catch {
        setError("Belum bisa memulai. Periksa koneksi lalu coba lagi.");
        return;
      }
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setLeaving(true);
      try {
        window.location.assign(result.data.url);
      } catch {
        setLeaving(false);
        setError("Halaman TikTok tidak bisa dibuka. Coba lagi.");
      }
    });
  }

  function disconnect() {
    setError(null);
    startDisconnect(async () => {
      let result: Awaited<ReturnType<typeof disconnectTikTokAction>>;
      try {
        result = await disconnectTikTokAction();
      } catch {
        setError("Belum bisa memutuskan. Periksa koneksi lalu coba lagi.");
        setConfirmOpen(false);
        return;
      }
      setConfirmOpen(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast.success(TIKTOK_DISCONNECTED_MESSAGE);
      router.refresh();
    });
  }

  const busy = connecting || disconnecting || leaving;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button onClick={connect} loading={connecting || leaving} disabled={disabled || busy} className="w-full sm:w-auto">
          {mode === "connect" ? "Hubungkan TikTok Shop" : "Hubungkan ulang"}
        </Button>
        {canDisconnect && (
          <Button variant="secondary" onClick={() => setConfirmOpen(true)} disabled={busy} className="w-full sm:w-auto">
            Putuskan
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger-700">
          {error}
        </p>
      )}
      <Dialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Putuskan TikTok Shop?"
        description="Token dihapus dan sinkronisasi berhenti. Pesanan yang sudah masuk tetap ada. Untuk mencabut izin sepenuhnya, hapus juga aplikasi Ammari Admin di Seller Center."
        confirmLabel="Putuskan"
        confirmVariant="danger"
        onConfirm={disconnect}
        loading={disconnecting}
      />
    </div>
  );
}
