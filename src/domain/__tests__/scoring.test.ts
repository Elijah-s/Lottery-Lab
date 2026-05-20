import { describe, expect, it } from "vitest";
import {
  buildFrequencyProfile,
  scoreCandidate,
  type DrawRecord,
} from "@/domain/scoring";
import type { SsqSingle } from "@/domain/ticketMath";

function makeSsqHistory(): DrawRecord[] {
  // 10 synthetic SSQ draws, newest first.
  return [
    { lotteryType: "ssq", issue: "2025110", drawDate: "2025-09-20", red: [1, 3, 7, 12, 18, 27], blue: [3] },
    { lotteryType: "ssq", issue: "2025109", drawDate: "2025-09-18", red: [5, 11, 16, 22, 28, 30], blue: [8] },
    { lotteryType: "ssq", issue: "2025108", drawDate: "2025-09-16", red: [2, 8, 13, 19, 24, 29], blue: [2] },
    { lotteryType: "ssq", issue: "2025107", drawDate: "2025-09-14", red: [4, 9, 14, 20, 25, 31], blue: [11] },
    { lotteryType: "ssq", issue: "2025106", drawDate: "2025-09-12", red: [6, 10, 15, 21, 26, 33], blue: [5] },
    { lotteryType: "ssq", issue: "2025105", drawDate: "2025-09-10", red: [1, 8, 16, 23, 28, 32], blue: [9] },
    { lotteryType: "ssq", issue: "2025104", drawDate: "2025-09-08", red: [3, 11, 17, 22, 27, 30], blue: [12] },
    { lotteryType: "ssq", issue: "2025103", drawDate: "2025-09-06", red: [2, 7, 15, 19, 25, 29], blue: [4] },
    { lotteryType: "ssq", issue: "2025102", drawDate: "2025-09-04", red: [5, 13, 18, 24, 26, 31], blue: [7] },
    { lotteryType: "ssq", issue: "2025101", drawDate: "2025-09-02", red: [4, 10, 14, 20, 23, 33], blue: [10] },
  ];
}

describe("buildFrequencyProfile", () => {
  it("returns empty profile for empty history", () => {
    expect(buildFrequencyProfile([], "red")).toEqual({});
  });

  it("counts red appearances and surfaces age of zero for the latest", () => {
    const history = makeSsqHistory();
    const profile = buildFrequencyProfile(history, "red");
    expect(profile[1].count).toBe(2);
    expect(profile[1].age).toBe(0);
    expect(profile[5].count).toBe(2);
    expect(profile[5].age).toBe(1);
    expect(profile[1].frequency).toBeCloseTo(2 / 10);
  });
});

describe("scoreCandidate", () => {
  const history = makeSsqHistory();

  function makeTicket(reds: number[], blue: number): SsqSingle {
    return { lotteryType: "ssq", mode: "single", reds, blues: [blue] };
  }

  it("is deterministic for the same inputs", () => {
    const ticket = makeTicket([2, 8, 15, 19, 24, 29], 5);
    const a = scoreCandidate("ssq", ticket, history, 20, 2, "balanced");
    const b = scoreCandidate("ssq", ticket, history, 20, 2, "balanced");
    expect(a).toEqual(b);
  });

  it("returns sane breakdown keys and a numeric score", () => {
    const ticket = makeTicket([2, 8, 15, 19, 24, 29], 5);
    const snap = scoreCandidate("ssq", ticket, history, 20, 2, "balanced");
    expect(Object.keys(snap.breakdown).sort()).toEqual([
      "balancedFrequency",
      "budgetUtilization",
      "coldCoverage",
      "strategyBias",
    ]);
    expect(Number.isFinite(snap.score)).toBe(true);
    expect(snap.score).toBeGreaterThanOrEqual(0);
  });

  it("rewards anti_popular when candidate uses high numbers", () => {
    const ticketHigh = makeTicket([27, 28, 29, 30, 31, 33], 10);
    const ticketLow = makeTicket([1, 2, 3, 4, 5, 6], 1);
    const high = scoreCandidate("ssq", ticketHigh, history, 20, 2, "anti_popular");
    const low = scoreCandidate("ssq", ticketLow, history, 20, 2, "anti_popular");
    expect(high.breakdown.strategyBias).toBeGreaterThan(
      low.breakdown.strategyBias,
    );
  });

  it("penalizes recency_fade when candidate overlaps recent draws", () => {
    const overlap = makeTicket([1, 3, 7, 12, 18, 27], 3); // = history[0]
    const fresh = makeTicket([4, 9, 14, 20, 25, 31], 7);
    const overlapScore = scoreCandidate("ssq", overlap, history, 20, 2, "recency_fade");
    const freshScore = scoreCandidate("ssq", fresh, history, 20, 2, "recency_fade");
    expect(freshScore.breakdown.strategyBias).toBeGreaterThan(
      overlapScore.breakdown.strategyBias,
    );
  });
});
