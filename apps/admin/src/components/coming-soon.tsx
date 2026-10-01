import { PageHeader, EmptyState } from "@ammari/ui";

export function ComingSoonPage({ title, description }: { title: string; description?: string }) {
  return (
    <>
      <PageHeader title={title} description={description} />
      <EmptyState title="Segera hadir" description="Halaman ini sedang dikembangkan." />
    </>
  );
}
