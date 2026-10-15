import { describe, expect, test } from "vitest";
import {
  featureBlockContentSchema,
  heroContentSchema,
  productGridContentSchema,
  whyAmmariContentSchema,
} from "./homepage-schemas";

const PRODUCT_ID = "11111111-1111-4111-8111-111111111111";
const COLOR_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_PRODUCT_ID = "33333333-3333-4333-8333-333333333333";

describe("heroContentSchema", () => {
  test("accepts an anchor CTA with no product reference", () => {
    const result = heroContentSchema.safeParse({
      eyebrow: "Koleksi Terbaru",
      headline: "Gamis Syar'i\nuntuk Setiap Momen",
      ctaLabel: "Belanja Sekarang",
      ctaTarget: { type: "anchor" },
      image: null,
    });
    expect(result.success).toBe(true);
  });

  test("accepts a product CTA with a color reference", () => {
    const result = heroContentSchema.safeParse({
      eyebrow: "",
      headline: "Headline",
      ctaLabel: "Lihat",
      ctaTarget: { type: "product", productId: PRODUCT_ID, fabricColorId: COLOR_ID },
      image: null,
    });
    expect(result.success).toBe(true);
  });

  test("rejects a blank headline", () => {
    const result = heroContentSchema.safeParse({
      eyebrow: "",
      headline: "   ",
      ctaLabel: "Lihat",
      ctaTarget: { type: "anchor" },
      image: null,
    });
    expect(result.success).toBe(false);
  });

  test("rejects a product CTA missing a productId", () => {
    const result = heroContentSchema.safeParse({
      eyebrow: "",
      headline: "Headline",
      ctaLabel: "Lihat",
      ctaTarget: { type: "product" },
      image: null,
    });
    expect(result.success).toBe(false);
  });

  test("rejects an unknown ctaTarget type", () => {
    const result = heroContentSchema.safeParse({
      eyebrow: "",
      headline: "Headline",
      ctaLabel: "Lihat",
      ctaTarget: { type: "category" },
      image: null,
    });
    expect(result.success).toBe(false);
  });
});

describe("productGridContentSchema", () => {
  test("accepts distinct tiles, including two tiles for the same product with different colors", () => {
    const result = productGridContentSchema.safeParse({
      title: "Pilihan Favorit",
      tiles: [
        { productId: PRODUCT_ID, fabricColorId: COLOR_ID },
        { productId: PRODUCT_ID, fabricColorId: null },
        { productId: OTHER_PRODUCT_ID, fabricColorId: null },
      ],
    });
    expect(result.success).toBe(true);
  });

  test("rejects a duplicate (productId, fabricColorId) pair", () => {
    const result = productGridContentSchema.safeParse({
      title: "Pilihan Favorit",
      tiles: [
        { productId: PRODUCT_ID, fabricColorId: COLOR_ID },
        { productId: PRODUCT_ID, fabricColorId: COLOR_ID },
      ],
    });
    expect(result.success).toBe(false);
  });

  test("rejects a duplicate null-color pair for the same product", () => {
    const result = productGridContentSchema.safeParse({
      title: "Pilihan Favorit",
      tiles: [
        { productId: PRODUCT_ID, fabricColorId: null },
        { productId: PRODUCT_ID, fabricColorId: null },
      ],
    });
    expect(result.success).toBe(false);
  });

  test("rejects a blank title", () => {
    const result = productGridContentSchema.safeParse({ title: "", tiles: [] });
    expect(result.success).toBe(false);
  });

  test("accepts an empty tile list", () => {
    const result = productGridContentSchema.safeParse({ title: "Pilihan Favorit", tiles: [] });
    expect(result.success).toBe(true);
  });
});

describe("featureBlockContentSchema", () => {
  test("accepts a complete feature block", () => {
    const result = featureBlockContentSchema.safeParse({
      title: "Judul",
      subtitle: "Subjudul",
      ctaLabel: "Lihat Produk",
      linkedProduct: { productId: PRODUCT_ID, fabricColorId: null },
      image: null,
    });
    expect(result.success).toBe(true);
  });

  test("rejects a missing linkedProduct", () => {
    const result = featureBlockContentSchema.safeParse({
      title: "Judul",
      subtitle: "Subjudul",
      ctaLabel: "Lihat Produk",
      image: null,
    });
    expect(result.success).toBe(false);
  });
});

describe("whyAmmariContentSchema", () => {
  function point(icon: string, title = "Judul") {
    return { icon, title, text: "Teks poin" };
  }

  test("accepts up to 4 points with valid icon keys", () => {
    const result = whyAmmariContentSchema.safeParse({
      eyebrow: "",
      heading: "Kenapa Pilih Kami",
      points: [
        point("syari_design"),
        point("premium_fabric"),
        point("careful_tailoring"),
        point("all_day_comfort"),
      ],
    });
    expect(result.success).toBe(true);
  });

  test("rejects a 5th point", () => {
    const result = whyAmmariContentSchema.safeParse({
      eyebrow: "",
      heading: "Kenapa Pilih Kami",
      points: [
        point("syari_design"),
        point("premium_fabric"),
        point("careful_tailoring"),
        point("all_day_comfort"),
        point("easy_care"),
      ],
    });
    expect(result.success).toBe(false);
  });

  test("rejects an unknown icon key", () => {
    const result = whyAmmariContentSchema.safeParse({
      eyebrow: "",
      heading: "Kenapa Pilih Kami",
      points: [point("not_a_real_icon")],
    });
    expect(result.success).toBe(false);
  });

  test("rejects a point with a blank title", () => {
    const result = whyAmmariContentSchema.safeParse({
      eyebrow: "",
      heading: "Kenapa Pilih Kami",
      points: [point("syari_design", "")],
    });
    expect(result.success).toBe(false);
  });
});
