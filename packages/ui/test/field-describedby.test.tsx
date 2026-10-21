// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { Checkbox } from "../src/components/Checkbox";
import { Input } from "../src/components/Input";
import { Select } from "../src/components/Select";
import { Textarea } from "../src/components/Textarea";
import { mergeDescribedBy } from "../src/lib/describedby";

// A caller's aria-describedby (help text) and the field's own error id must both survive: the
// props spread inside each field once replaced the merged value with the caller's alone, so an
// error was never announced on a field that also had a hint.

describe("field aria-describedby", () => {
  test("Input keeps the caller's hint and adds the error id", () => {
    render(<Input id="weight" aria-label="Berat" aria-describedby="weight-hint" error="Salah." />);
    expect(screen.getByLabelText("Berat")).toHaveAttribute("aria-describedby", "weight-hint weight-error");
  });

  test("Textarea, Select and Checkbox do the same", () => {
    render(
      <>
        <Textarea id="notes" aria-label="Catatan" aria-describedby="notes-hint" error="Salah." />
        <Select id="chart" aria-label="Tabel" aria-describedby="chart-hint" error="Salah.">
          <option value="">-</option>
        </Select>
        <Checkbox id="agree" label="Setuju" aria-describedby="agree-hint" error="Salah." />
      </>,
    );
    expect(screen.getByLabelText("Catatan")).toHaveAttribute("aria-describedby", "notes-hint notes-error");
    expect(screen.getByLabelText("Tabel")).toHaveAttribute("aria-describedby", "chart-hint chart-error");
    expect(screen.getByLabelText("Setuju")).toHaveAttribute("aria-describedby", "agree-hint agree-error");
  });

  test("without an error only the hint is referenced; without either, none", () => {
    render(
      <>
        <Input id="a" aria-label="A" aria-describedby="a-hint" />
        <Input id="b" aria-label="B" />
      </>,
    );
    expect(screen.getByLabelText("A")).toHaveAttribute("aria-describedby", "a-hint");
    expect(screen.getByLabelText("B")).not.toHaveAttribute("aria-describedby");
  });

  test("mergeDescribedBy drops an error id the caller already listed", () => {
    expect(mergeDescribedBy("hint x-error", "x-error")).toBe("hint x-error");
    expect(mergeDescribedBy(undefined, undefined)).toBeUndefined();
  });
});
