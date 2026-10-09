"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Label, Select, Textarea } from "@ammari/ui";
import { MARKETPLACE_CHANNEL_IDS } from "@ammari/db/schema";
import type { ChannelId } from "@ammari/db/schema";
import { todayInJakarta } from "@/lib/products/jakarta-date";
import type { OrderableVariantRow } from "@/lib/orders/queries";
import type { ChannelOption } from "@/lib/orders/queries";
import type { CustomerOption } from "@/lib/customers/queries";
import { createCustomerAction, createOrderAction, searchCustomersAction } from "../actions";
import { OrderItemPicker, type OrderLine } from "./order-item-picker";

type CustomerMode = "none" | "existing" | "new";

export function OrderForm({ channels, variants }: { channels: ChannelOption[]; variants: OrderableVariantRow[] }) {
  const router = useRouter();
  const [channelId, setChannelId] = useState<ChannelId>(channels[0]?.id ?? "offline");
  const [channelOrderNo, setChannelOrderNo] = useState("");
  const [orderDate, setOrderDate] = useState(todayInJakarta());
  const [status, setStatus] = useState<"awaiting_payment" | "to_ship">("to_ship");

  const [customerMode, setCustomerMode] = useState<CustomerMode>("none");
  const [customerQuery, setCustomerQuery] = useState("");
  const [customerResults, setCustomerResults] = useState<CustomerOption[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerOption | null>(null);
  const [newCustomerName, setNewCustomerName] = useState("");
  const [newCustomerPhone, setNewCustomerPhone] = useState("");
  const [buyerUsername, setBuyerUsername] = useState("");

  const [shippingAddress, setShippingAddress] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Record<string, OrderLine>>({});
  const [discountAmount, setDiscountAmount] = useState("");
  const [shippingAmount, setShippingAmount] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const isMarketplace = MARKETPLACE_CHANNEL_IDS.includes(channelId);

  useEffect(() => {
    // All setState calls happen inside the timeout callback, never synchronously in the effect
    // body itself (react-hooks/set-state-in-effect) — including the "nothing to search" clear.
    const handle = setTimeout(() => {
      if (customerMode !== "existing" || customerQuery.trim().length === 0) {
        setCustomerResults([]);
        return;
      }
      searchCustomersAction(customerQuery).then(setCustomerResults).catch(() => setCustomerResults([]));
    }, 250);
    return () => clearTimeout(handle);
  }, [customerMode, customerQuery]);

  function handleLineChange(sku: string, line: OrderLine) {
    setLines((prev) => ({ ...prev, [sku]: line }));
  }

  function handleSubmit() {
    setError(null);
    const items = Object.entries(lines)
      .filter(([, line]) => line.qty > 0)
      .map(([sku, line]) => ({ sku, qty: line.qty, unitPrice: line.unitPrice }));
    if (items.length === 0) {
      setError("Pilih minimal 1 item untuk dipesan.");
      return;
    }
    if (isMarketplace && !channelOrderNo.trim()) {
      setError("Nomor pesanan marketplace wajib diisi untuk kanal ini.");
      return;
    }
    if (customerMode === "new" && !newCustomerName.trim()) {
      setError("Nama pelanggan baru wajib diisi.");
      return;
    }

    startTransition(async () => {
      let customerId: string | undefined;
      if (customerMode === "existing") {
        customerId = selectedCustomer?.id;
      } else if (customerMode === "new") {
        const customerResult = await createCustomerAction({ name: newCustomerName, phone: newCustomerPhone || undefined });
        if (!customerResult.ok) {
          setError(customerResult.error);
          return;
        }
        customerId = customerResult.data.id;
      }

      const result = await createOrderAction({
        channelId,
        channelOrderNo: channelOrderNo || undefined,
        orderDate,
        customerId,
        buyerUsername: buyerUsername || undefined,
        shippingAddress: shippingAddress || undefined,
        notes: notes || undefined,
        items,
        discountAmount,
        shippingAmount,
        status,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push(`/orders/${result.data.id}`);
    });
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        handleSubmit();
      }}
      className="flex flex-col gap-6"
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="order-channel" required>
              Kanal
            </Label>
            <Select id="order-channel" value={channelId} onChange={(event) => setChannelId(event.target.value as ChannelId)}>
              {channels.map((channel) => (
                <option key={channel.id} value={channel.id}>
                  {channel.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="order-date" required>
              Tanggal pesanan
            </Label>
            <Input id="order-date" type="date" value={orderDate} onChange={(event) => setOrderDate(event.target.value)} />
          </div>
        </div>
        <div>
          <Label htmlFor="order-channel-no" required={isMarketplace}>
            Nomor pesanan marketplace
          </Label>
          <Input
            id="order-channel-no"
            value={channelOrderNo}
            onChange={(event) => setChannelOrderNo(event.target.value)}
            placeholder={isMarketplace ? "Wajib diisi" : "Opsional"}
          />
        </div>
        <div>
          <Label htmlFor="order-status" required>
            Status awal
          </Label>
          <Select id="order-status" value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>
            <option value="to_ship">Siap Kirim (sudah dibayar)</option>
            <option value="awaiting_payment">Menunggu Bayar</option>
          </Select>
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-4">
        <h2 className="text-lg font-semibold text-neutral-900">Pelanggan</h2>
        <Select value={customerMode} onChange={(event) => setCustomerMode(event.target.value as CustomerMode)} aria-label="Jenis pelanggan">
          <option value="none">Tanpa akun pelanggan</option>
          <option value="existing">Pilih pelanggan yang sudah ada</option>
          <option value="new">Pelanggan baru</option>
        </Select>

        {customerMode === "none" && (
          <div>
            <Label htmlFor="buyer-username">Nama/username pembeli</Label>
            <Input id="buyer-username" value={buyerUsername} onChange={(event) => setBuyerUsername(event.target.value)} placeholder="Opsional" />
          </div>
        )}

        {customerMode === "existing" && (
          <div className="flex flex-col gap-2">
            <Label htmlFor="customer-search">Cari nama atau nomor HP</Label>
            <Input
              id="customer-search"
              value={customerQuery}
              onChange={(event) => {
                setCustomerQuery(event.target.value);
                setSelectedCustomer(null);
              }}
            />
            {selectedCustomer ? (
              <p className="text-sm text-neutral-700">
                Dipilih: <span className="font-medium">{selectedCustomer.name}</span>
                {selectedCustomer.phone ? ` (${selectedCustomer.phone})` : ""}
              </p>
            ) : (
              customerResults.length > 0 && (
                <ul className="flex flex-col gap-1 rounded-md border border-neutral-200">
                  {customerResults.map((customer) => (
                    <li key={customer.id}>
                      <button
                        type="button"
                        className="w-full px-3 py-2 text-left text-base hover:bg-neutral-100"
                        onClick={() => {
                          setSelectedCustomer(customer);
                          setCustomerQuery(customer.name);
                          setCustomerResults([]);
                        }}
                      >
                        {customer.name}
                        {customer.phone ? <span className="ml-2 text-sm text-neutral-600">{customer.phone}</span> : null}
                      </button>
                    </li>
                  ))}
                </ul>
              )
            )}
          </div>
        )}

        {customerMode === "new" && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="new-customer-name" required>
                Nama
              </Label>
              <Input id="new-customer-name" value={newCustomerName} onChange={(event) => setNewCustomerName(event.target.value)} />
            </div>
            <div>
              <Label htmlFor="new-customer-phone">No. HP</Label>
              <Input
                id="new-customer-phone"
                value={newCustomerPhone}
                onChange={(event) => setNewCustomerPhone(event.target.value)}
                placeholder="+62..."
              />
            </div>
          </div>
        )}
      </div>

      <OrderItemPicker variants={variants} lines={lines} onLineChange={handleLineChange} />

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="order-discount">Diskon penjual</Label>
          <Input id="order-discount" inputMode="numeric" value={discountAmount} onChange={(event) => setDiscountAmount(event.target.value)} placeholder="0" />
        </div>
        <div>
          <Label htmlFor="order-shipping">Ongkos kirim (ditanggung pembeli)</Label>
          <Input id="order-shipping" inputMode="numeric" value={shippingAmount} onChange={(event) => setShippingAmount(event.target.value)} placeholder="0" />
        </div>
      </div>

      <div>
        <Label htmlFor="order-shipping-address">Alamat pengiriman</Label>
        <Textarea id="order-shipping-address" value={shippingAddress} onChange={(event) => setShippingAddress(event.target.value)} rows={2} />
      </div>

      <div>
        <Label htmlFor="order-notes">Catatan</Label>
        <Textarea id="order-notes" value={notes} onChange={(event) => setNotes(event.target.value)} rows={2} />
      </div>

      {error && (
        <p role="alert" className="text-base text-danger-700">
          {error}
        </p>
      )}
      <Button type="submit" loading={pending}>
        Simpan pesanan
      </Button>
    </form>
  );
}
