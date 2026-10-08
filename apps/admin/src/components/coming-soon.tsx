import { PageHeader, EmptyState, Breadcrumb } from "@ammari/ui";
import { rootCrumbs } from "@/lib/nav/breadcrumb";

export function ComingSoonPage({ href, title, description }: { href: string; title: string; description?: string }) {
  return (
    <>
      <Breadcrumb items={rootCrumbs(href)} />
      <PageHeader title={title} description={description} />
      <EmptyState title="Segera hadir" description="Halaman ini sedang dikembangkan." />
    </>
  );
}
