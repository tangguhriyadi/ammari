"use client";

import type { ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import { PAGE_SIZE_OPTIONS } from "../lib/pagination";
import { Select } from "./Select";

export interface PerPageSelectProps {
  /** The route this list lives on, e.g. "/products". */
  basePath: string;
  /** Other query params to preserve (e.g. { q: "gamis" }) — `page` and `perPage` are set by
   * this component itself, never passed in here. */
  searchParams?: Record<string, string | undefined>;
  value: number;
}

/** Changing the page size always navigates back to page 1 — a page number that made sense at
 * the old size can be past the end at the new one, so there is no "stay on the same page" that
 * would be meaningful here. */
export function PerPageSelect({ basePath, searchParams = {}, value }: PerPageSelectProps) {
  const router = useRouter();

  function handleChange(event: ChangeEvent<HTMLSelectElement>) {
    const params = new URLSearchParams();
    for (const [key, val] of Object.entries(searchParams)) {
      if (val) params.set(key, val);
    }
    const nextPerPage = event.target.value;
    params.set("perPage", nextPerPage);
    const query = params.toString();
    router.push(query ? `${basePath}?${query}` : basePath);
  }

  return (
    <label className="flex items-center gap-2 text-sm text-neutral-600">
      Tampilkan
      <Select
        aria-label="Jumlah per halaman"
        value={value}
        onChange={handleChange}
        className="min-h-9 w-auto px-2 pr-7 text-sm"
      >
        {PAGE_SIZE_OPTIONS.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </Select>
    </label>
  );
}
