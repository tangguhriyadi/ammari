import { serializeJsonLd } from "@/lib/seo/json-ld";

/** One `<script type="application/ld+json">` per object (pages render one per type). Always through `serializeJsonLd`, never a bare
 * `JSON.stringify`: admin-entered text (a product name) must not be able to close the tag. */
export function JsonLd({ data }: { data: Record<string, unknown> }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }} />;
}
