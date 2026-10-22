import { and, desc, eq, isNotNull, notInArray, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { z } from "zod";
import { orders, shipments } from "@ammari/db/schema";
import { createFakeShipmentProvider } from "@ammari/commerce/shipping";
import { defaultDb } from "@/lib/db";
import { isE2eFixturesRequestAllowed } from "@/lib/fixtures/e2e-fixtures-gate";
import { getTrackingReader } from "@/lib/shipping/tracking-runtime";
import { webhookSecretsFromEnv } from "@/lib/shipping/webhook-auth";
import { POST as webhookPost } from "../../../shipping/biteship/webhook/[token]/route";

// e2e only (docs/plans/cart-checkout.md §15 Phase K, K3): moves a booked shipment along in the fake
// courier and then posts a webhook through the REAL webhook route (path token and header secret from
// this server's env), which re-fetches the order from the fake and applies only that answer, exactly
// as it does with Biteship. Behind the same three fail-closed conditions as the fixtures route
// (non-production build, E2E_TEST_LOGIN=true, a loopback Host) plus the fake tracking provider, and
// deploy/Caddyfile blocks /api/test/* at the edge anyway.
//
// The fake keeps its orders per process, and admin booked this one in its own process: the shipment
// is first adopted from what the database stored. The 2-minute re-fetch debounce is reset for this
// shipment, so a test can take several steps in a row. Answers 202 once the webhook is accepted;
// the order changes right after (the webhook processes after its own answer), so tests wait for it.

export const dynamic = "force-dynamic";

const body = z.object({
  orderNo: z.string().regex(/^ORD-[0-9]{6}-[0-9]{4,}$/),
  status: z.string().min(1).max(40).optional(),
  price: z.number().int().nonnegative().optional(),
  waybill: z.string().regex(/^[A-Za-z0-9-]{1,40}$/).optional(),
});

function answer(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Cache-Control": "no-store", "Content-Type": "application/json" } });
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isE2eFixturesRequestAllowed({ nodeEnv: process.env.NODE_ENV, e2eTestLoginFlag: process.env.E2E_TEST_LOGIN, host: request.headers.get("host") })) {
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  if (getTrackingReader()?.name !== "fake") return answer(409, { error: "SHIPPING_ORDER_PROVIDER is not fake" });
  const secrets = webhookSecretsFromEnv(process.env);
  if (!secrets.ok) return answer(409, { error: "webhook not configured", problems: secrets.problems });

  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return answer(400, { error: "bad request" });
  const input = parsed.data;

  const [shipment] = await defaultDb
    .select({
      id: shipments.id,
      providerOrderId: shipments.providerOrderId,
      referenceId: shipments.referenceId,
      awb: shipments.awb,
      courier: shipments.courier,
      service: shipments.service,
      costAmount: shipments.costAmount,
      providerStatus: shipments.providerStatus,
    })
    .from(shipments)
    .innerJoin(orders, eq(orders.id, shipments.orderId))
    .where(and(eq(orders.orderNo, input.orderNo), isNotNull(shipments.providerOrderId), notInArray(shipments.status, ["failed"])))
    .orderBy(desc(shipments.attempt))
    .limit(1);
  if (!shipment?.providerOrderId) return answer(404, { error: "no booked shipment for this order" });

  const fake = createFakeShipmentProvider();
  fake.controls.adopt({
    providerOrderId: shipment.providerOrderId,
    referenceId: shipment.referenceId,
    waybillId: shipment.awb,
    courierCode: shipment.courier,
    serviceCode: shipment.service,
    price: shipment.costAmount,
    providerStatus: shipment.providerStatus,
  });
  try {
    if (input.price !== undefined) fake.controls.setPrice(shipment.providerOrderId, input.price);
    if (input.waybill !== undefined) fake.controls.setWaybill(shipment.providerOrderId, input.waybill);
    if (input.status !== undefined) fake.controls.advance(shipment.providerOrderId, input.status);
  } catch (error) {
    return answer(400, { error: error instanceof Error ? error.message : "fake refused" });
  }
  await defaultDb.update(shipments).set({ lastPolledAt: null, updatedAt: sql`now()` }).where(eq(shipments.id, shipment.id));

  const { pathToken, headerName, headerSecret } = secrets.secrets;
  const webhook = new Request(new URL(`/api/shipping/biteship/webhook/${pathToken}`, request.url), {
    method: "POST",
    headers: { "content-type": "application/json", [headerName]: headerSecret },
    // Like Biteship's own: only `event` and `order_id` are read; the status is never trusted.
    body: JSON.stringify({ event: "order.status", order_id: shipment.providerOrderId, status: input.status ?? null }),
  });
  const response = await webhookPost(webhook, { params: Promise.resolve({ token: pathToken }) });
  return answer(202, { webhookStatus: response.status, providerOrderId: shipment.providerOrderId });
}
