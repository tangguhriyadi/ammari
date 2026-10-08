"use client";

import Link from "next/link";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Card, EmptyState, Switch, TableContainer, TableHead, Th, Tr, Td, CardList } from "@ammari/ui";
import { formatRupiah } from "@ammari/ui/lib";
import type { CostComponentType, CostComponentUnit } from "@ammari/db/schema";
import { setCostComponentActiveAction } from "../actions";

const UNIT_LABELS: Record<CostComponentUnit, string> = {
  pcs: "Pcs",
  meter: "Meter",
  yard: "Yard",
  lusin: "Lusin",
  set: "Set",
};

const COST_TYPE_LABELS: Record<CostComponentType, string> = {
  variable: "Variabel",
  fixed: "Tetap",
};

export interface CostComponentRow {
  id: string;
  name: string;
  unit: CostComponentUnit;
  defaultUnitPrice: number | null;
  costType: CostComponentType;
  isActive: boolean;
}

export function CostComponentList({ components }: { components: CostComponentRow[] }) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  if (components.length === 0) {
    return <EmptyState title="Belum ada komponen biaya" description="Tambah komponen untuk mulai mencatat biaya selain bahan." />;
  }

  function handleToggle(id: string, isActive: boolean) {
    startTransition(async () => {
      await setCostComponentActiveAction({ id, isActive });
      router.refresh();
    });
  }

  return (
    <>
      <CardList>
        {components.map((component) => (
          <li key={component.id}>
            <Card className="flex items-center gap-3">
              <Link href={`/production/cost-components/${component.id}`} className="flex-1">
                <p className="text-base text-neutral-900">{component.name}</p>
                <p className="text-sm text-neutral-600">
                  {COST_TYPE_LABELS[component.costType]} · {UNIT_LABELS[component.unit]}
                  {component.defaultUnitPrice !== null ? ` · ${formatRupiah(component.defaultUnitPrice)}` : ""}
                </p>
              </Link>
              {!component.isActive && <Badge variant="neutral">Nonaktif</Badge>}
              <Switch
                checked={component.isActive}
                onCheckedChange={(checked) => handleToggle(component.id, checked)}
                label=""
                accessibleLabel={`Aktif untuk ${component.name}`}
              />
            </Card>
          </li>
        ))}
      </CardList>

      <TableContainer>
        <TableHead>
          <Th>Nama</Th>
          <Th>Jenis</Th>
          <Th>Satuan</Th>
          <Th>Harga default</Th>
          <Th>Status</Th>
        </TableHead>
        <tbody>
          {components.map((component) => (
            <Tr key={component.id}>
              <Td>
                <Link href={`/production/cost-components/${component.id}`} className="font-medium text-brand hover:underline">
                  {component.name}
                </Link>
              </Td>
              <Td className="text-neutral-700">{COST_TYPE_LABELS[component.costType]}</Td>
              <Td className="text-neutral-700">{UNIT_LABELS[component.unit]}</Td>
              <Td className="text-neutral-700 tabular-nums">
                {component.defaultUnitPrice !== null ? formatRupiah(component.defaultUnitPrice) : "—"}
              </Td>
              <Td>
                <div className="flex items-center gap-2">
                  {!component.isActive && <Badge variant="neutral">Nonaktif</Badge>}
                  <Switch
                    checked={component.isActive}
                    onCheckedChange={(checked) => handleToggle(component.id, checked)}
                    label=""
                    accessibleLabel={`Aktif untuk ${component.name}`}
                  />
                </div>
              </Td>
            </Tr>
          ))}
        </tbody>
      </TableContainer>
    </>
  );
}
