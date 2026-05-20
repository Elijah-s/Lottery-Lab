import { describe, expect, it } from "vitest";
import {
  DLT_RULES,
  SSQ_RULES,
  getRuleNotes,
  getRuleVersion,
  type LotteryType,
} from "@/domain/lotteryRules";

describe("getRuleVersion", () => {
  it("returns the single SSQ rule version", () => {
    const rule = getRuleVersion("ssq", new Date("2025-01-01"));
    expect(rule).toBe(SSQ_RULES);
    expect(rule.primaryRange).toEqual([1, 33]);
    expect(rule.secondaryRange).toEqual([1, 16]);
  });

  it("rejects dates before SSQ's effective date", () => {
    expect(() =>
      getRuleVersion("ssq", new Date("2000-01-01")),
    ).toThrowError(/No SSQ rule version/);
  });

  it("picks the older DLT rule for pre-2026 dates", () => {
    const rule = getRuleVersion("dlt", new Date("2025-06-01"));
    expect(rule.ruleVersion).toBe("dlt-2019-02-20");
  });

  it("picks the newer DLT rule on/after 2026-02-02", () => {
    const rule = getRuleVersion("dlt", new Date("2026-02-02"));
    expect(rule.ruleVersion).toBe("dlt-2026-02-02");
  });

  it("rejects pre-2019 DLT dates", () => {
    expect(() =>
      getRuleVersion("dlt", new Date("2018-05-01")),
    ).toThrowError(/No DLT rule version/);
  });

  it("throws for unsupported lottery types", () => {
    expect(() =>
      getRuleVersion("foo" as unknown as LotteryType, new Date("2025-01-01")),
    ).toThrowError(/Unsupported lottery type/);
  });

  it("keeps DLT rules chronologically ordered", () => {
    const dates = DLT_RULES.map((rule) => rule.effectiveFrom);
    const sorted = [...dates].sort();
    expect(dates).toEqual(sorted);
  });
});

describe("getRuleNotes", () => {
  it("covers all three play modes for SSQ", () => {
    const notes = getRuleNotes("ssq");
    expect(Object.keys(notes).sort()).toEqual(["danTuo", "multiple", "single"]);
    expect(notes.single).toContain("6 红");
  });

  it("mentions additional pricing for DLT", () => {
    const notes = getRuleNotes("dlt");
    expect(notes.multiple).toContain("追加");
  });
});
