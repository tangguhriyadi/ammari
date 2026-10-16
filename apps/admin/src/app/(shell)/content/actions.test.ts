import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Same mocking strategy as content/size-charts/actions.test.ts — exercises requirePermission's
// actual enforcement without a real session/DB.
const { getStaffSessionMock } = vi.hoisted(() => ({ getStaffSessionMock: vi.fn() }));
vi.mock("@/lib/auth/staff-session", () => ({ getStaffSession: getStaffSessionMock }));

// Auto-mocked (every export becomes a no-op vi.fn()) — safe for every OTHER test in this file,
// since none of them reach past permission/validation rejection into the real homepage module
// (confirmed by reading every test below). Only the new "publish still succeeds when
// revalidation fails" test configures these mocks' return values.
vi.mock("@/lib/content/homepage");
vi.mock("@/lib/content/info-pages");
vi.mock("@/lib/revalidate");

const {
  saveHeroDraftAction,
  saveProductGridDraftAction,
  saveFeatureBlockDraftAction,
  saveWhyAmmariDraftAction,
  setHomepageSectionVisibilityAction,
  publishHomepageAction,
  retryHomepageRevalidationAction,
  createHomepagePreviewLinkAction,
  discardHomepageDraftAction,
  saveInfoPageDraftAction,
  publishInfoPageAction,
  discardInfoPageDraftAction,
} = await import("./actions");
const homepageMock = await import("@/lib/content/homepage");
const revalidateMock = await import("@/lib/revalidate");

function sessionWithPermissions(permissionKeys: string[]) {
  return {
    staffUser: { id: "staff-1", name: "Test Staff", email: "staff@example.test", roleId: "role-1" },
    role: { id: "role-1", key: "test_role", name: "Test Role" },
    permissionKeys,
  };
}

const VALID_HERO = {
  isVisible: true,
  content: { eyebrow: "", headline: "Headline", ctaLabel: "Lihat", ctaTarget: { type: "anchor" as const }, image: null },
};
const VALID_PRODUCT_GRID = { isVisible: true, content: { title: "Grid", tiles: [] } };
const VALID_FEATURE_BLOCK = {
  isVisible: true,
  content: {
    title: "Judul",
    subtitle: "Subjudul",
    ctaLabel: "Lihat",
    linkedProduct: { productId: "11111111-1111-4111-8111-111111111111", fabricColorId: null },
    image: null,
  },
};
const VALID_WHY_AMMARI = { isVisible: true, content: { eyebrow: "", heading: "Kenapa Pilih Kami", points: [] } };

describe("homepage content actions require content.manage, NOT products.manage", () => {
  test.each([
    ["saveHeroDraftAction", () => saveHeroDraftAction(VALID_HERO)],
    ["saveProductGridDraftAction", () => saveProductGridDraftAction(VALID_PRODUCT_GRID)],
    ["saveFeatureBlockDraftAction", () => saveFeatureBlockDraftAction(VALID_FEATURE_BLOCK)],
    ["saveWhyAmmariDraftAction", () => saveWhyAmmariDraftAction(VALID_WHY_AMMARI)],
    ["setHomepageSectionVisibilityAction", () => setHomepageSectionVisibilityAction("hero", true)],
    ["publishHomepageAction", () => publishHomepageAction()],
    ["discardHomepageDraftAction", () => discardHomepageDraftAction()],
    ["retryHomepageRevalidationAction", () => retryHomepageRevalidationAction()],
    ["createHomepagePreviewLinkAction", () => createHomepagePreviewLinkAction()],
  ] as const)("%s rejects a session holding products.manage but NOT content.manage", async (_name, run) => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["products.manage"]));
    await expect(run()).rejects.toThrow();
  });

  test("an unauthenticated session (null) redirects rather than proceeding", async () => {
    getStaffSessionMock.mockResolvedValueOnce(null);
    await expect(saveHeroDraftAction(VALID_HERO)).rejects.toThrow();
  });
});

describe("publishHomepageAction never fails because revalidation failed (docs/plans/storefront-cms.md session 6)", () => {
  test("still returns ok:true, with revalidationOk:false, when revalidateHomepage() reports failure", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["content.manage"]));
    vi.mocked(homepageMock.publishHomepageSections).mockResolvedValueOnce(undefined);
    vi.mocked(revalidateMock.revalidateHomepage).mockResolvedValueOnce({ ok: false });

    const result = await publishHomepageAction();

    expect(result).toEqual({ ok: true, data: { revalidationOk: false } });
    expect(homepageMock.publishHomepageSections).toHaveBeenCalledTimes(1);
  });

  test("returns revalidationOk:true when revalidateHomepage() succeeds", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["content.manage"]));
    vi.mocked(homepageMock.publishHomepageSections).mockResolvedValueOnce(undefined);
    vi.mocked(revalidateMock.revalidateHomepage).mockResolvedValueOnce({ ok: true });

    const result = await publishHomepageAction();

    expect(result).toEqual({ ok: true, data: { revalidationOk: true } });
  });
});

describe("retryHomepageRevalidationAction", () => {
  test("re-runs only the revalidation call and reports its outcome", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["content.manage"]));
    vi.mocked(revalidateMock.revalidateHomepage).mockResolvedValueOnce({ ok: true });

    const result = await retryHomepageRevalidationAction();

    expect(result).toEqual({ ok: true, data: { revalidationOk: true } });
  });
});

describe("createHomepagePreviewLinkAction", () => {
  let savedSecret: string | undefined;

  beforeEach(() => {
    savedSecret = process.env.PREVIEW_SECRET;
    process.env.PREVIEW_SECRET = "test-preview-secret";
  });

  afterEach(() => {
    if (savedSecret === undefined) delete process.env.PREVIEW_SECRET;
    else process.env.PREVIEW_SECRET = savedSecret;
  });

  test("returns a link to apps/web's PUBLIC origin, with a non-empty token", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["content.manage"]));
    const result = await createHomepagePreviewLinkAction();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.data.url).toMatch(/^http:\/\/localhost:3000\/preview\/home\?token=\S+$/);
  });
});

describe("homepage content action validation (shape only — never reaches the DB)", () => {
  test("saveHeroDraftAction rejects a blank headline", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["content.manage"]));
    const result = await saveHeroDraftAction({ ...VALID_HERO, content: { ...VALID_HERO.content, headline: "   " } });
    expect(result.ok).toBe(false);
  });

  test("saveHeroDraftAction rejects a product CTA with no productId", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["content.manage"]));
    const result = await saveHeroDraftAction({
      ...VALID_HERO,
      content: { ...VALID_HERO.content, ctaTarget: { type: "product" as const, productId: "", fabricColorId: null } },
    });
    expect(result.ok).toBe(false);
  });

  test("saveProductGridDraftAction rejects a duplicate (productId, fabricColorId) tile pair", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["content.manage"]));
    const tile = { productId: "11111111-1111-4111-8111-111111111111", fabricColorId: null };
    const result = await saveProductGridDraftAction({ isVisible: true, content: { title: "Grid", tiles: [tile, tile] } });
    expect(result.ok).toBe(false);
  });

  test("saveFeatureBlockDraftAction rejects a missing linkedProduct", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["content.manage"]));
    const { title, subtitle, ctaLabel } = VALID_FEATURE_BLOCK.content;
    const result = await saveFeatureBlockDraftAction({ isVisible: true, content: { title, subtitle, ctaLabel } as never });
    expect(result.ok).toBe(false);
  });

  test("saveWhyAmmariDraftAction rejects a 5th point", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["content.manage"]));
    const point = { icon: "syari_design" as const, title: "Judul", text: "Teks" };
    const result = await saveWhyAmmariDraftAction({
      isVisible: true,
      content: { eyebrow: "", heading: "Kenapa Pilih Kami", points: [point, point, point, point, point] },
    });
    expect(result.ok).toBe(false);
  });

  test("saveWhyAmmariDraftAction rejects an unknown icon key", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["content.manage"]));
    const result = await saveWhyAmmariDraftAction({
      isVisible: true,
      content: { eyebrow: "", heading: "Kenapa Pilih Kami", points: [{ icon: "not_a_real_icon", title: "Judul", text: "Teks" }] as never },
    });
    expect(result.ok).toBe(false);
  });

  test("setHomepageSectionVisibilityAction rejects an unknown section key", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["content.manage"]));
    const result = await setHomepageSectionVisibilityAction("not_a_real_key", true);
    expect(result.ok).toBe(false);
  });
});

describe("info page actions require content.manage, NOT products.manage (session 8)", () => {
  test.each([
    ["saveInfoPageDraftAction", () => saveInfoPageDraftAction("shipping", { title: "Pengiriman", bodyHtml: "<p>Isi</p>" })],
    ["publishInfoPageAction", () => publishInfoPageAction("shipping")],
    ["discardInfoPageDraftAction", () => discardInfoPageDraftAction("shipping")],
  ] as const)("%s rejects a session holding products.manage but NOT content.manage", async (_name, run) => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["products.manage"]));
    await expect(run()).rejects.toThrow();
  });

  test("an unauthenticated session (null) redirects rather than proceeding", async () => {
    getStaffSessionMock.mockResolvedValueOnce(null);
    await expect(saveInfoPageDraftAction("shipping", { title: "Pengiriman", bodyHtml: "<p>Isi</p>" })).rejects.toThrow();
  });
});

describe("info page action validation (shape + slug only — never reaches the DB)", () => {
  test("saveInfoPageDraftAction rejects a blank title", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["content.manage"]));
    const result = await saveInfoPageDraftAction("shipping", { title: "   ", bodyHtml: "<p>Isi</p>" });
    expect(result.ok).toBe(false);
  });

  test.each(["saveInfoPageDraftAction", "publishInfoPageAction", "discardInfoPageDraftAction"] as const)(
    "%s rejects a slug outside INFO_PAGE_SLUGS",
    async (name) => {
      getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["content.manage"]));
      const result =
        name === "saveInfoPageDraftAction"
          ? await saveInfoPageDraftAction("not-a-real-slug", { title: "x", bodyHtml: "<p>Isi</p>" })
          : name === "publishInfoPageAction"
            ? await publishInfoPageAction("not-a-real-slug")
            : await discardInfoPageDraftAction("not-a-real-slug");
      expect(result.ok).toBe(false);
    },
  );
});
