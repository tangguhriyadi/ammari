import postgres from "postgres";

// Direct writes to `store_settings` in ammari_e2e, for specs that need to flip the announcement
// bar or the homepage meta mid-run. apps/web reads store_settings UNCACHED on every request
// (lib/store-settings.ts), so a write here is visible on the very next page load, no
// revalidation needed. Same target derivation and fail-closed guard as playwright.config.ts's
// e2eDatabaseUrl()/global-setup.ts: only ever host localhost/127.0.0.1, database "ammari_e2e".

function e2eDatabaseUrl(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is not set");
  const url = new URL(raw);
  url.pathname = "/ammari_e2e";
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error(`Refusing to write e2e store settings to non-local host "${url.hostname}".`);
  }
  return url.toString();
}

export interface E2eStorefrontSettings {
  announcementBarEnabled?: boolean;
  announcementBarText?: string | null;
  homepageMetaTitle?: string | null;
  homepageMetaDescription?: string | null;
}

/** Exactly what storefront-fixtures.ts seeds — call from `afterEach`/`afterAll` to restore. */
export const E2E_STOREFRONT_SETTINGS_DEFAULTS: Required<E2eStorefrontSettings> = {
  announcementBarEnabled: true,
  announcementBarText: "Gratis Ongkir Ke Seluruh Indonesia",
  homepageMetaTitle: null,
  homepageMetaDescription: null,
};

export async function setStorefrontSettings(values: E2eStorefrontSettings): Promise<void> {
  const merged = { ...E2E_STOREFRONT_SETTINGS_DEFAULTS, ...values };
  const sql = postgres(e2eDatabaseUrl(), { max: 1, onnotice: () => {} });
  try {
    await sql`
      update store_settings set
        announcement_bar_enabled = ${merged.announcementBarEnabled},
        announcement_bar_text = ${merged.announcementBarText},
        homepage_meta_title = ${merged.homepageMetaTitle},
        homepage_meta_description = ${merged.homepageMetaDescription}
      where id = 1`;
  } finally {
    await sql.end();
  }
}
