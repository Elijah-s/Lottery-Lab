import { describe, expect, it } from "vitest";
import { parseUserRequest } from "@/domain/parsing";
import { generateCandidates } from "@/domain/recommendation";
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

describe("generateCandidates", () => {
  it("generates a DLT additional recommendation within budget", () => {
    const parsed = parseUserRequest("大乐透 30 元 追加 激进");
    const bundle = generateCandidates(parsed, makeDltHistory(140));

    expect(bundle.topCandidate.ticket.lotteryType).toBe("dlt");
    expect(bundle.topCandidate.amount).toBeLessThanOrEqual(parsed.budget);
    expect(bundle.topCandidate.formatted).toContain("追加");
    expect(bundle.candidates.length).toBeGreaterThan(0);
  });
});
