/**
 * Natural-language request parser.
 *
 * Turns a free-form Chinese request (e.g. 「双色球 20 元稳一点」) into a
 * structured `ParsedRequest`. The parser is intentionally lightweight
 * and rule-based — the downstream LLM step is where nuance goes; we
 * only need to pin down the deterministic fields here.
 */

import type { LotteryType, PlayMode } from "@/domain/lotteryRules";

export type Tone = "conservative" | "balanced" | "aggressive";

export interface ParsedRequest {
  lotteryType: LotteryType;
  budget: number;
  tone: Tone;
  playMode: PlayMode;
  additional: boolean;
  explorationMode: boolean;
  historyWindowSize: number;
  historyWindowSource: "default" | "user";
  rawRequest: string;
  issues: string[];
}

export const DEFAULT_HISTORY_WINDOW_SIZE = 200;
export const MAX_HISTORY_WINDOW_SIZE = 1000;

const LOTTERY_SSQ = /(?:双色球|ssq)/i;
const LOTTERY_DLT = /(?:大乐透|dlt)/i;
const BUDGET_PATTERN = /(\d+(?:\.\d+)?)\s*(?:元|块钱|块)/;
const HISTORY_WINDOW_PATTERN =
  /(?:最近|近|参考|根据|基于|使用|用|取|回看|分析)\s*(\d{1,4})\s*(?:期|期开奖|期数据|期历史|期走势|期样本)|(\d{1,4})\s*(?:期|期开奖|期数据|期历史|期走势|期样本)\s*(?:数据|历史|走势|样本|分析|统计|回看|窗口)/;

const TONE_CONSERVATIVE = /(?:稳|保守|谨慎|安全)/;
const TONE_AGGRESSIVE = /(?:激进|刺激|冒险|大胆|猛)/;

const PLAY_MULTIPLE = /(?:复式)/;
const PLAY_DANTUO = /(?:胆拖|胆)/;

const ADDITIONAL = /追加/;
const EXPLORATION = /(?:再来一组|换一组|再给一组|再抽一组)/;

/**
 * Parse a user's natural-language betting request.
 *
 * Conflicts (e.g. 「稳一点又激进」, 「双色球 追加」) are not errors —
 * they surface via `issues` so the UI can show a warning while still
 * producing a workable `ParsedRequest` with sensible defaults.
 */
export function parseUserRequest(text: string): ParsedRequest {
  const rawRequest = text ?? "";
  const normalized = rawRequest.trim();
  const issues: string[] = [];

  if (!normalized) {
    issues.push("请求为空，请输入一条自然语言描述。");
  }

  const matchSsq = LOTTERY_SSQ.test(normalized);
  const matchDlt = LOTTERY_DLT.test(normalized);
  let lotteryType: LotteryType = "ssq";
  if (matchSsq && matchDlt) {
    issues.push("同时命中 双色球 与 大乐透，默认按 双色球 处理。");
    lotteryType = "ssq";
  } else if (matchDlt) {
    lotteryType = "dlt";
  } else if (matchSsq) {
    lotteryType = "ssq";
  } else if (normalized.length > 0) {
    issues.push("未识别到彩种关键词，默认按 双色球 处理。");
  }

  const budgetMatch = normalized.match(BUDGET_PATTERN);
  let budget = 20;
  if (budgetMatch) {
    const parsed = Number.parseFloat(budgetMatch[1]);
    if (Number.isFinite(parsed)) {
      budget = Math.round(parsed);
    }
  }
  if (budget < 2) {
    issues.push("预算不足 2 元，已回退到最小可投注金额 2 元。");
    budget = 2;
  }
  if (budget > 200000) {
    issues.push("预算超过 20 万元，已截断到 20 万元。");
    budget = 200000;
  }

  const matchConservative = TONE_CONSERVATIVE.test(normalized);
  const matchAggressive = TONE_AGGRESSIVE.test(normalized);
  let tone: Tone = "balanced";
  if (matchConservative && matchAggressive) {
    issues.push("同时命中 稳健 与 激进 关键词，默认按 平衡 处理。");
    tone = "balanced";
  } else if (matchConservative) {
    tone = "conservative";
  } else if (matchAggressive) {
    tone = "aggressive";
  }

  let playMode: PlayMode = "single";
  if (PLAY_DANTUO.test(normalized)) {
    playMode = "danTuo";
  } else if (PLAY_MULTIPLE.test(normalized)) {
    playMode = "multiple";
  }

  const hasAdditional = ADDITIONAL.test(normalized);
  let additional = false;
  if (hasAdditional) {
    if (lotteryType === "dlt") {
      additional = true;
    } else {
      issues.push("追加 只适用于 大乐透，已忽略。");
    }
  }

  const explorationMode = EXPLORATION.test(normalized);
  const historyWindow = parseHistoryWindow(normalized, issues);

  return {
    lotteryType,
    budget,
    tone,
    playMode,
    additional,
    explorationMode,
    historyWindowSize: historyWindow.size,
    historyWindowSource: historyWindow.source,
    rawRequest,
    issues,
  };
}

function parseHistoryWindow(
  normalized: string,
  issues: string[],
): { size: number; source: "default" | "user" } {
  const match = normalized.match(HISTORY_WINDOW_PATTERN);
  if (!match) {
    return { size: DEFAULT_HISTORY_WINDOW_SIZE, source: "default" };
  }

  const rawValue = match[1] ?? match[2] ?? "";
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed)) {
    return { size: DEFAULT_HISTORY_WINDOW_SIZE, source: "default" };
  }

  if (parsed < 1) {
    issues.push("历史分析窗口不能小于 1 期，已按 1 期处理。");
    return { size: 1, source: "user" };
  }
  if (parsed > MAX_HISTORY_WINDOW_SIZE) {
    issues.push(
      `历史分析窗口最大支持 ${MAX_HISTORY_WINDOW_SIZE} 期，已自动截断。`,
    );
    return { size: MAX_HISTORY_WINDOW_SIZE, source: "user" };
  }
  return { size: parsed, source: "user" };
}
