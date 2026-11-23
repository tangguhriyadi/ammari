// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { SizeChartTable } from "./size-chart-table";

const ROWS = [
  { size: "S", bustCm: 92, lengthCm: 131, sleeveLengthCm: 56, heightRecommendationMinCm: 151, heightRecommendationMaxCm: 161 },
  { size: "M", bustCm: 94, lengthCm: 132, sleeveLengthCm: 57, heightRecommendationMinCm: 152, heightRecommendationMaxCm: 162 },
] as const;

describe("SizeChartTable", () => {
  test("shows the measurement tolerance note right after the table", () => {
    render(<SizeChartTable rows={[...ROWS]} />);
    const note = screen.getByTestId("size-chart-tolerance-note");
    expect(note).toHaveTextContent("*Ukuran dapat berbeda 1–2 cm karena proses jahit dan pengukuran manual.");
    expect(note.previousElementSibling).toBe(screen.getByTestId("size-chart-scroll"));
  });
});
