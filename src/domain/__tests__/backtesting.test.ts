import { describe, expect, it } from "vitest";
import { runBacktest } from "@/domain/backtesting";
import type { DrawRecord } from "@/domain/scoring";

function pickUnique(start: number, count: number, max: number, step: number): number[] {
  const values: number[] = [];
  let cursor = start;
  while (values.length < count) {
    const value = ((cursor - 1) % max) + 1;
    if (!values.includes(value)) values.push(value);
    cursor += step;
  }
  return values.sort((a, b) => a - b);
}

function makeDltHistory(count: number): DrawRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    lotteryType: "dlt",
    issue: String(26080 - index).padStart(5, "0"),
    drawDate: "2026-05-01",
    front: pickUnique(index + 1, 5, 35, 7),
    back: pickUnique(index + 1, 2, 12, 5),
  }));
}

describe("runBacktest", () => {
  it("uses the selected lottery type even when request text mentions another lottery", () => {
    const result = runBacktest({
      lotteryType: "dlt",
      requestText: "双色球 20 元 平衡",
      startIssue: "26040",
      endIssue: "26045",
      strategies: ["balanced"],
      history: makeDltHistory(170),
    });

    expect(result.summary.sample_count).toBeGreaterThan(0);
    expect(result.configSnapshot.lottery_type).toBe("dlt");
    expect(result.samples[0].generated_numbers.lotteryType).toBe("dlt");
    expect(result.samples[0].actual_numbers.front).toHaveLength(5);
  });
});
