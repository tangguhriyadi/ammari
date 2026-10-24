import { ProductStepPage } from "../_components/product-step-page";

/** Edit mode: every step can be opened directly with `?step=` (docs/plans/product-stepper.md). */
export default async function ProdukDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  return <ProductStepPage id={id} mode="edit" searchParams={query} />;
}
