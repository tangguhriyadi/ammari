import { existsSync } from "node:fs";

/** Inserts `to_ship` orders directly into `ammari_e2e`, bypassing the UI entirely. Used only by
 * the WebKit print spec, to work around an unrelated, pre-existing WebKit incompatibility
 * discovered while wiring up that project: clicking "Simpan" on /fabrics/new never fires a
 * network request at all under WebKit (confirmed via console/network logging), so the normal
 * fabric → product → stock → order UI flow every other e2e test uses can't complete there. That
 * bug is unrelated to the print-timing fix this spec exists to verify and deserves its own
 * investigation — this is a scoped workaround for test SETUP only, not a fix for it.
 *
 * Mirrors e2e/global-setup.ts's own "repoint DATABASE_URL to ammari_e2e BEFORE the first
 * @ammari/db import" dance exactly, for the same reason: a static/early import of `@ammari/db`
 * would otherwise cache a `db` singleton pointed at the owner's real local `ammari` database for
 * the rest of this process. `deriveE2eDatabaseUrl` itself is safe to import first — it's pure
 * URL math with no DB/module side effect. */
export async function insertToShipOrdersDirectly(count: number): Promise<string[]> {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) throw new Error("DATABASE_URL is not set");

  const { deriveE2eDatabaseUrl } = await import("@ammari/db/test-e2e-db");
  const e2eUrl = deriveE2eDatabaseUrl(baseUrl);
  process.env.DATABASE_URL = e2eUrl.toString();

  const { db } = await import("@ammari/db");
  const { insertOrder } = await import("@ammari/db/test-fixtures");

  const orderNos: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const order = await insertOrder(db, { buyerUsername: "E2E WebKit" });
    orderNos.push(order.orderNo);
  }
  return orderNos;
}
