import type { HomepageSectionContent } from "@ammari/db/storefront";
import { WHY_AMMARI_ICON_LABELS, type WhyAmmariIconKey } from "@ammari/db/why-ammari";

// Deliberately NOT the real homepage design (docs/plans/storefront-cms.md session 7 builds
// that, with the design doc + mockups in hand) — this renders the DRAFT content's fields
// plainly, just enough for the owner to confirm what they typed/staged actually saved, before
// clicking "Terbitkan". Every field is read defensively (duck-typed, optional chaining, no
// `as`/schema import from apps/admin — apps/web has no access to apps/admin's `src/` tree across
// the monorepo boundary, same reasoning apps/web/src/lib/claim/token.ts's own doc comment gives
// for not importing admin code) — malformed or missing content renders a fallback line instead
// of crashing the whole preview.

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function productRefLabel(ref: unknown): string {
  if (typeof ref !== "object" || ref === null) return "(tidak ada produk)";
  const productId = "productId" in ref && typeof ref.productId === "string" ? ref.productId : null;
  const fabricColorId = "fabricColorId" in ref && typeof ref.fabricColorId === "string" ? ref.fabricColorId : null;
  if (!productId) return "(tidak ada produk)";
  return fabricColorId ? `produk ${productId} — warna ${fabricColorId}` : `produk ${productId} — semua warna`;
}

function HeroSection({ content }: { content: unknown }) {
  const data = typeof content === "object" && content !== null ? (content as Record<string, unknown>) : {};
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">Hero</p>
      {text(data.eyebrow) && <p className="text-sm text-neutral-600">{text(data.eyebrow)}</p>}
      <h2 className="whitespace-pre-line text-2xl font-semibold text-neutral-900">
        {text(data.headline) ?? "(headline belum diisi)"}
      </h2>
      <p className="text-sm text-neutral-700">Tombol: {text(data.ctaLabel) ?? "(belum diisi)"}</p>
    </section>
  );
}

function ProductGridSection({ content }: { content: unknown }) {
  const data = typeof content === "object" && content !== null ? (content as Record<string, unknown>) : {};
  const tiles = Array.isArray(data.tiles) ? data.tiles : [];
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">Grid Produk</p>
      <h2 className="text-xl font-semibold text-neutral-900">{text(data.title) ?? "(judul belum diisi)"}</h2>
      {tiles.length === 0 ? (
        <p className="text-sm text-neutral-600">Belum ada produk di grid ini.</p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm text-neutral-700">
          {tiles.map((tile, index) => (
            <li key={index}>
              {index + 1}. {productRefLabel(tile)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function FeatureBlockSection({ content }: { content: unknown }) {
  const data = typeof content === "object" && content !== null ? (content as Record<string, unknown>) : {};
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">Feature Block</p>
      <h2 className="text-xl font-semibold text-neutral-900">{text(data.title) ?? "(judul belum diisi)"}</h2>
      <p className="text-sm text-neutral-700">{text(data.subtitle) ?? "(subjudul belum diisi)"}</p>
      <p className="text-sm text-neutral-600">Terhubung ke: {productRefLabel(data.linkedProduct)}</p>
    </section>
  );
}

function WhyAmmariSection({ content }: { content: unknown }) {
  const data = typeof content === "object" && content !== null ? (content as Record<string, unknown>) : {};
  const points = Array.isArray(data.points) ? data.points : [];
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">Kenapa Ammari</p>
      {text(data.eyebrow) && <p className="text-sm text-neutral-600">{text(data.eyebrow)}</p>}
      <h2 className="text-xl font-semibold text-neutral-900">{text(data.heading) ?? "(judul belum diisi)"}</h2>
      {points.length === 0 ? (
        <p className="text-sm text-neutral-600">Belum ada poin.</p>
      ) : (
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {points.map((point, index) => {
            const row = typeof point === "object" && point !== null ? (point as Record<string, unknown>) : {};
            const iconKey = typeof row.icon === "string" ? (row.icon as WhyAmmariIconKey) : null;
            return (
              <li key={index} className="rounded-md bg-neutral-50 p-3 text-sm">
                <p className="font-medium text-neutral-900">{text(row.title) ?? "(judul belum diisi)"}</p>
                <p className="text-neutral-700">{text(row.text) ?? "(teks belum diisi)"}</p>
                {iconKey && <p className="text-xs text-neutral-500">Ikon: {WHY_AMMARI_ICON_LABELS[iconKey] ?? iconKey}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

const SECTION_RENDERERS: Record<HomepageSectionContent["key"], (props: { content: unknown }) => React.JSX.Element> = {
  hero: HeroSection,
  product_grid: ProductGridSection,
  feature_block: FeatureBlockSection,
  why_ammari: WhyAmmariSection,
};

/** Renders every DRAFT section in canonical order, skipping any the admin has hidden
 * (`isVisible: false`) — same visibility rule the real published homepage will use in session 7,
 * so this preview reflects what "Terbitkan" would actually produce. */
export function StructuralHomepageSections({ sections }: { sections: HomepageSectionContent[] }) {
  const visible = sections.filter((section) => section.isVisible);
  if (visible.length === 0) {
    return <p className="text-sm text-neutral-600">Semua bagian halaman utama sedang disembunyikan di draft ini.</p>;
  }
  return (
    <div className="flex flex-col gap-6">
      {visible.map((section) => {
        const Renderer = SECTION_RENDERERS[section.key];
        return <Renderer key={section.key} content={section.content} />;
      })}
    </div>
  );
}
