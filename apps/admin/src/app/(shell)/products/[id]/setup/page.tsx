import { ProductStepPage } from "../../_components/product-step-page";

/** Create mode for a draft saved in step 1: steps open in order, later ones stay locked until the
 * steps before them are done (docs/plans/product-stepper.md). */
export default async function ProdukSetupPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  return <ProductStepPage id={id} mode="create" searchParams={query} />;
}
