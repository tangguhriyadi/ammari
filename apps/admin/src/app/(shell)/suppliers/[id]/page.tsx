import { notFound } from "next/navigation";
import { PageHeader, Badge, Breadcrumb } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { getSupplierById } from "@/lib/suppliers/queries";
import { supplierKindLabels, type SupplierKind } from "@/lib/suppliers/kinds";
// Reused, not re-implemented: the one existing Indonesian-phone normalizer in this app (added
// for the storefront's WhatsApp button). It returns null for anything that isn't a plausible
// mobile number — a landline or a half-typed number then renders as plain text instead of a
// broken wa.me link.
import { normalizeWhatsappNumber } from "@/lib/content/store-settings-schema";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { SupplierForm } from "../_components/supplier-form";

function DetailRow({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div>
      <dt className="text-sm text-neutral-600">{label}</dt>
      <dd className="text-base text-neutral-900">{value}</dd>
    </div>
  );
}

export default async function SupplierDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission("inventory.view");
  const { id } = await params;

  const supplier = await getSupplierById(id);
  if (!supplier) notFound();

  const canManage = session.permissionKeys.includes("inventory.manage");
  const kindLabels = supplierKindLabels(supplier.kinds);
  const whatsappNumber = supplier.phone ? normalizeWhatsappNumber(supplier.phone) : null;

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/suppliers"), { label: supplier.name }]} />
      <div className="flex items-center justify-between gap-2">
        <PageHeader title={supplier.name} description={kindLabels.join(" · ") || undefined} />
        {!supplier.isActive && <Badge variant="neutral">Nonaktif</Badge>}
      </div>

      {supplier.phone && (
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <span className="text-base text-neutral-900">{supplier.phone}</span>
          {whatsappNumber && (
            <a
              href={`https://wa.me/${whatsappNumber}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-base font-medium text-brand hover:underline"
            >
              Chat WhatsApp →
            </a>
          )}
        </div>
      )}

      {canManage ? (
        <SupplierForm
          mode="edit"
          supplierId={supplier.id}
          initialValues={{
            name: supplier.name,
            // `kinds` is a plain text[] at the DB level (same as products.highlights) — the
            // allowed values are guaranteed by suppliers_kinds_allowed_check and re-validated
            // by the action's Zod enum, so this cast is a projection, not a trust decision.
            kinds: supplier.kinds as SupplierKind[],
            phone: supplier.phone ?? "",
            address: supplier.address ?? "",
            bankName: supplier.bankName ?? "",
            bankAccountNo: supplier.bankAccountNo ?? "",
            bankAccountName: supplier.bankAccountName ?? "",
            notes: supplier.notes ?? "",
            isActive: supplier.isActive,
          }}
        />
      ) : (
        // A session with `inventory.view` but not `inventory.manage` reads the same data without
        // an editable form at all — the actions are permission-gated on the server regardless
        // (docs/SPEC.md §9), this just avoids offering a form every save would 403 on.
        <dl className="flex flex-col gap-4">
          <DetailRow label="Jenis" value={kindLabels.join(", ") || null} />
          <DetailRow label="Alamat" value={supplier.address} />
          <DetailRow label="Nama bank" value={supplier.bankName} />
          <DetailRow label="Nomor rekening" value={supplier.bankAccountNo} />
          <DetailRow label="Nama pemilik rekening" value={supplier.bankAccountName} />
          <DetailRow label="Catatan" value={supplier.notes} />
        </dl>
      )}
    </>
  );
}
