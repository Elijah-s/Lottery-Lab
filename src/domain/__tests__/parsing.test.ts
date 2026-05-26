import { describe, expect, it } from "vitest";
import { parseUserRequest } from "@/domain/parsing";

describe("parseUserRequest", () => {
  it("parses 双色球 20 元稳一点", () => {
    const parsed = parseUserRequest("双色球 20 元稳一点");
    expect(parsed.lotteryType).toBe("ssq");
    expect(parsed.budget).toBe(20);
    expect(parsed.tone).toBe("conservative");
    expect(parsed.playMode).toBe("single");
    expect(parsed.additional).toBe(false);
    expect(parsed.historyWindowSize).toBe(200);
    expect(parsed.historyWindowSource).toBe("default");
    expect(parsed.issues).toEqual([]);
  });

  it("parses 大乐透 10 元 追加 激进", () => {
    const parsed = parseUserRequest("大乐透 10 元 追加 激进");
    expect(parsed.lotteryType).toBe("dlt");
    expect(parsed.tone).toBe("aggressive");
    expect(parsed.additional).toBe(true);
    expect(parsed.issues).toEqual([]);
  });

  it("flags 追加 on SSQ as an issue and ignores it", () => {
    const parsed = parseUserRequest("双色球 追加 30 块");
    expect(parsed.additional).toBe(false);
    expect(parsed.issues).toEqual(
      expect.arrayContaining([expect.stringMatching(/追加/)]),
    );
  });

  it("detects 胆拖 play mode", () => {
    const parsed = parseUserRequest("双色球 100 块 胆拖 保守一点");
    expect(parsed.playMode).toBe("danTuo");
    expect(parsed.tone).toBe("conservative");
  });

  it("detects 复式 play mode when 胆拖 is absent", () => {
    const parsed = parseUserRequest("大乐透 30 元 复式 再来一组");
    expect(parsed.playMode).toBe("multiple");
    expect(parsed.explorationMode).toBe(true);
  });

  it("flags conflicting tones and falls back to balanced", () => {
    const parsed = parseUserRequest("双色球 50 元 稳又激进");
    expect(parsed.tone).toBe("balanced");
    expect(parsed.issues).toEqual(
      expect.arrayContaining([expect.stringMatching(/稳健|激进/)]),
    );
  });

  it("flags missing lottery keyword and defaults to SSQ", () => {
    const parsed = parseUserRequest("给我来一注 20 块钱 平衡");
    expect(parsed.lotteryType).toBe("ssq");
    expect(parsed.issues).toEqual(
      expect.arrayContaining([expect.stringMatching(/彩种|双色球/)]),
    );
  });

  it("flags conflicting lotteries and prefers SSQ", () => {
    const parsed = parseUserRequest("双色球和大乐透都来点 20 元");
    expect(parsed.lotteryType).toBe("ssq");
    expect(parsed.issues).toEqual(
      expect.arrayContaining([expect.stringMatching(/双色球|大乐透/)]),
    );
  });

  it("clamps sub-2-yuan budgets and records an issue", () => {
    const parsed = parseUserRequest("双色球 0 元");
    expect(parsed.budget).toBe(2);
    expect(parsed.issues).toEqual(
      expect.arrayContaining([expect.stringMatching(/预算/)]),
    );
  });

  it("returns issues for empty input but still produces defaults", () => {
    const parsed = parseUserRequest("");
    expect(parsed.lotteryType).toBe("ssq");
    expect(parsed.budget).toBe(20);
    expect(parsed.issues.length).toBeGreaterThan(0);
  });

  it("parses an explicit recent history window", () => {
    const parsed = parseUserRequest("双色球 20 元 最近 50 期 稳一点");
    expect(parsed.historyWindowSize).toBe(50);
    expect(parsed.historyWindowSource).toBe("user");
  });

  it("parses a data-analysis history window", () => {
    const parsed = parseUserRequest("大乐透 30 元 根据 500 期数据分析 追加");
    expect(parsed.historyWindowSize).toBe(500);
    expect(parsed.historyWindowSource).toBe("user");
  });

  it("clamps overly large history windows", () => {
    const parsed = parseUserRequest("双色球 20 元 参考 5000 期数据");
    expect(parsed.historyWindowSize).toBe(1000);
    expect(parsed.issues).toEqual(
      expect.arrayContaining([expect.stringMatching(/历史分析窗口/)]),
    );
  });
});
