/**
 * Candidate recommendation generation.
 *
 * This is the pure / deterministic layer: given a parsed request and a
 * validated historical window, produce a ranked list of candidate
 * tickets. No randomness beyond a seeded RNG — same input, same output,
 * which makes debugging and backtesting reproducible.
 *
 * The LLM explanation step is handled separately (Rust side, PR4/7).
 */

import {
  getRuleVersion,
} from "@/domain/lotteryRules";
import type { ParsedRequest } from "@/domain/parsing";
import {
  buildFrequencyProfile,
  scoreCandidate,
  type DrawRecord,
  type ScoreSnapshot,
  type StrategyName,
} from "@/domain/scoring";
import {
  calculateAmount,
  formatTicket,
  type DltDanTuo,
  type DltMultiple,
  type DltSingle,
  type SsqDanTuo,
  type SsqMultiple,
  type SsqSingle,
  type Ticket,
} from "@/domain/ticketMath";

export interface Candidate {
  ticket: Ticket;
  amount: number;
  scoreSnapshot: ScoreSnapshot;
  formatted: string;
}

export interface CandidateBundle {
  strategy: StrategyName;
  ruleVersion: string;
  targetIssue: string;
  historyWindowSize: number;
  validatedHistoryCount: number;
  topCandidate: Candidate;
  candidates: Candidate[];
}

const MIN_HISTORY_REQUIRED = 100;
const MAX_STRUCTURES = 10;
const CANDIDATES_PER_STRUCTURE = 8;
const TOP_KEEP = 5;

/**
 * Deterministic RNG (xorshift32) so seed → output is stable.
 * Small and good enough for candidate generation; not crypto.
 */
function makeRng(seed: number): () => number {
  let state = seed || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    // Normalize to [0, 1)
    return ((state >>> 0) / 0x100000000);
  };
}

function hashSeed(parts: (string | number)[]): number {
  const text = parts.join("|");
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function strategyFromTone(
  tone: ParsedRequest["tone"],
): StrategyName {
  if (tone === "aggressive") return "anti_popular";
  if (tone === "conservative") return "recency_fade";
  return "balanced";
}

export function generateCandidates(
  request: ParsedRequest,
  history: readonly DrawRecord[],
  options: {
    strategy?: StrategyName;
    drawDate?: Date;
  } = {},
): CandidateBundle {
  if (history.length < MIN_HISTORY_REQUIRED) {
    throw new Error(
      `历史开奖不足 ${MIN_HISTORY_REQUIRED} 期（当前仅 ${history.length} 期），请先同步数据。`,
    );
  }
  const rule = getRuleVersion(request.lotteryType, options.drawDate);
  const latestIssue = history[0]?.issue ?? "";
  if (!latestIssue) {
    throw new Error("历史开奖缺少期号字段。");
  }
  const strategy = options.strategy ?? strategyFromTone(request.tone);

  const seed = hashSeed([
    request.rawRequest,
    latestIssue,
    strategy,
    request.explorationMode ? Math.floor(Math.random() * 1e9) : 0,
  ]);
  const rng = makeRng(seed);

  const structures = buildStructures(request);
  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  for (const structure of structures.slice(0, MAX_STRUCTURES)) {
    for (let i = 0; i < CANDIDATES_PER_STRUCTURE; i += 1) {
      const ticket = buildTicket(request, structure, rng, strategy, history);
      const amount = calculateAmount(ticket);
      if (amount === 0 || amount > request.budget) continue;
      const formatted = formatTicket(ticket);
      if (seen.has(formatted)) continue;
      seen.add(formatted);
      const scoreSnapshot = scoreCandidate(
        request.lotteryType,
        ticket,
        history,
        request.budget,
        amount,
        strategy,
      );
      candidates.push({ ticket, amount, scoreSnapshot, formatted });
    }
  }

  candidates.sort((a, b) => {
    if (b.scoreSnapshot.score !== a.scoreSnapshot.score) {
      return b.scoreSnapshot.score - a.scoreSnapshot.score;
    }
    return b.amount - a.amount;
  });

  if (candidates.length === 0) {
    throw new Error("当前预算与玩法组合下没有生成合法候选，请调大预算或换玩法。");
  }

  const top = candidates.slice(0, TOP_KEEP);
  return {
    strategy,
    ruleVersion: rule.ruleVersion,
    targetIssue: nextIssue(latestIssue),
    historyWindowSize: history.length,
    validatedHistoryCount: history.length,
    topCandidate: top[0],
    candidates: top,
  };
}

function nextIssue(latest: string): string {
  const asNumber = Number.parseInt(latest, 10);
  if (!Number.isFinite(asNumber)) return latest;
  const next = asNumber + 1;
  return String(next).padStart(latest.length, "0");
}

type Structure =
  | { mode: "ssq-single" }
  | { mode: "ssq-multiple"; red: number; blue: number }
  | { mode: "ssq-danTuo"; redDan: number; redTuo: number; blue: number }
  | { mode: "dlt-single" }
  | { mode: "dlt-multiple"; front: number; back: number }
  | {
      mode: "dlt-danTuo";
      frontDan: number;
      frontTuo: number;
      backDan: number;
      backTuo: number;
    };

function buildStructures(request: ParsedRequest): Structure[] {
  if (request.lotteryType === "ssq") {
    if (request.playMode === "single") return [{ mode: "ssq-single" }];
    if (request.playMode === "multiple") {
      const list: Structure[] = [];
      for (let red = 7; red <= 10; red += 1) {
        for (let blue = 1; blue <= 4; blue += 1) {
          list.push({ mode: "ssq-multiple", red, blue });
        }
      }
      return list;
    }
    // danTuo
    const list: Structure[] = [];
    for (let redDan = 1; redDan <= 3; redDan += 1) {
      for (let redTuo = 6 - redDan; redTuo <= 8; redTuo += 1) {
        for (let blue = 1; blue <= 3; blue += 1) {
          list.push({ mode: "ssq-danTuo", redDan, redTuo, blue });
        }
      }
    }
    return list;
  }

  if (request.playMode === "single") return [{ mode: "dlt-single" }];
  if (request.playMode === "multiple") {
    const list: Structure[] = [];
    for (let front = 6; front <= 9; front += 1) {
      for (let back = 2; back <= 4; back += 1) {
        list.push({ mode: "dlt-multiple", front, back });
      }
    }
    return list;
  }
  const list: Structure[] = [];
  for (let frontDan = 1; frontDan <= 2; frontDan += 1) {
    for (let frontTuo = 5 - frontDan; frontTuo <= 7; frontTuo += 1) {
      list.push({
        mode: "dlt-danTuo",
        frontDan,
        frontTuo,
        backDan: 0,
        backTuo: 3,
      });
    }
  }
  return list;
}

function buildTicket(
  request: ParsedRequest,
  structure: Structure,
  rng: () => number,
  strategy: StrategyName,
  history: readonly DrawRecord[],
): Ticket {
  switch (structure.mode) {
    case "ssq-single":
      return buildSsqSingle(request, rng, strategy, history);
    case "ssq-multiple":
      return buildSsqMultiple(request, structure, rng, strategy, history);
    case "ssq-danTuo":
      return buildSsqDanTuo(request, structure, rng, strategy, history);
    case "dlt-single":
      return buildDltSingle(request, rng, strategy, history);
    case "dlt-multiple":
      return buildDltMultiple(request, structure, rng, strategy, history);
    case "dlt-danTuo":
      return buildDltDanTuo(request, structure, rng, strategy, history);
    default: {
      const _exhaustive: never = structure;
      throw new Error(`未知结构：${JSON.stringify(_exhaustive)}`);
    }
  }
}

function ssqPools(strategy: StrategyName, history: readonly DrawRecord[]) {
  const rule = getRuleVersion("ssq");
  return {
    redPool: rangeArray(rule.primaryRange[0], rule.primaryRange[1]),
    bluePool: rangeArray(rule.secondaryRange[0], rule.secondaryRange[1]),
    redWeights: strategyWeights(history, "red", strategy),
    blueWeights: strategyWeights(history, "blue", strategy),
  };
}

function dltPools(strategy: StrategyName, history: readonly DrawRecord[]) {
  const rule = getRuleVersion("dlt");
  return {
    frontPool: rangeArray(rule.primaryRange[0], rule.primaryRange[1]),
    backPool: rangeArray(rule.secondaryRange[0], rule.secondaryRange[1]),
    frontWeights: strategyWeights(history, "front", strategy),
    backWeights: strategyWeights(history, "back", strategy),
  };
}

function buildSsqSingle(
  _request: ParsedRequest,
  rng: () => number,
  strategy: StrategyName,
  history: readonly DrawRecord[],
): SsqSingle {
  const { redPool, bluePool, redWeights, blueWeights } = ssqPools(strategy, history);
  return {
    lotteryType: "ssq",
    mode: "single",
    reds: weightedPick(redPool, 6, rng, redWeights),
    blues: weightedPick(bluePool, 1, rng, blueWeights),
  };
}

function buildSsqMultiple(
  _request: ParsedRequest,
  structure: Extract<Structure, { mode: "ssq-multiple" }>,
  rng: () => number,
  strategy: StrategyName,
  history: readonly DrawRecord[],
): SsqMultiple {
  const { redPool, bluePool, redWeights, blueWeights } = ssqPools(strategy, history);
  return {
    lotteryType: "ssq",
    mode: "multiple",
    redBank: weightedPick(redPool, structure.red, rng, redWeights),
    blueBank: weightedPick(bluePool, structure.blue, rng, blueWeights),
  };
}

function buildSsqDanTuo(
  _request: ParsedRequest,
  structure: Extract<Structure, { mode: "ssq-danTuo" }>,
  rng: () => number,
  strategy: StrategyName,
  history: readonly DrawRecord[],
): SsqDanTuo {
  const { redPool, bluePool, redWeights, blueWeights } = ssqPools(strategy, history);
  const redPicks = weightedPick(
    redPool,
    structure.redDan + structure.redTuo,
    rng,
    redWeights,
  );
  return {
    lotteryType: "ssq",
    mode: "danTuo",
    redDan: redPicks.slice(0, structure.redDan).sort((a, b) => a - b),
    redTuo: redPicks.slice(structure.redDan).sort((a, b) => a - b),
    blueBank: weightedPick(bluePool, structure.blue, rng, blueWeights),
  };
}

function buildDltSingle(
  request: ParsedRequest,
  rng: () => number,
  strategy: StrategyName,
  history: readonly DrawRecord[],
): DltSingle {
  const { frontPool, backPool, frontWeights, backWeights } = dltPools(strategy, history);
  return {
    lotteryType: "dlt",
    mode: "single",
    front: weightedPick(frontPool, 5, rng, frontWeights),
    back: weightedPick(backPool, 2, rng, backWeights),
    additional: request.additional,
  };
}

function buildDltMultiple(
  request: ParsedRequest,
  structure: Extract<Structure, { mode: "dlt-multiple" }>,
  rng: () => number,
  strategy: StrategyName,
  history: readonly DrawRecord[],
): DltMultiple {
  const { frontPool, backPool, frontWeights, backWeights } = dltPools(strategy, history);
  return {
    lotteryType: "dlt",
    mode: "multiple",
    frontBank: weightedPick(frontPool, structure.front, rng, frontWeights),
    backBank: weightedPick(backPool, structure.back, rng, backWeights),
    additional: request.additional,
  };
}

function buildDltDanTuo(
  request: ParsedRequest,
  structure: Extract<Structure, { mode: "dlt-danTuo" }>,
  rng: () => number,
  strategy: StrategyName,
  history: readonly DrawRecord[],
): DltDanTuo {
  const { frontPool, backPool, frontWeights, backWeights } = dltPools(strategy, history);
  const frontPicks = weightedPick(
    frontPool,
    structure.frontDan + structure.frontTuo,
    rng,
    frontWeights,
  );
  const backPicks = weightedPick(
    backPool,
    structure.backDan + structure.backTuo,
    rng,
    backWeights,
  );
  return {
    lotteryType: "dlt",
    mode: "danTuo",
    frontDan: frontPicks.slice(0, structure.frontDan).sort((a, b) => a - b),
    frontTuo: frontPicks.slice(structure.frontDan).sort((a, b) => a - b),
    backDan: backPicks.slice(0, structure.backDan).sort((a, b) => a - b),
    backTuo: backPicks.slice(structure.backDan).sort((a, b) => a - b),
    additional: request.additional,
  };
}

function strategyWeights(
  history: readonly DrawRecord[],
  area: "red" | "blue" | "front" | "back",
  strategy: StrategyName,
): Record<number, number> {
  const profile = buildFrequencyProfile(history, area);
  const weights: Record<number, number> = {};
  for (const [numKey, entry] of Object.entries(profile)) {
    const n = Number(numKey);
    let w = 1 + Math.min(entry.age, 12) * 0.08 - entry.frequency * 2.5;
    if (strategy === "anti_popular" && n > 25) w += 0.4;
    if (strategy === "recency_fade" && entry.age < 3) w -= 0.6;
    weights[n] = Math.max(0.05, w);
  }
  return weights;
}

function rangeArray(start: number, end: number): number[] {
  const list: number[] = [];
  for (let i = start; i <= end; i += 1) list.push(i);
  return list;
}

function weightedPick(
  pool: number[],
  size: number,
  rng: () => number,
  weights: Record<number, number>,
): number[] {
  const remaining = [...pool];
  const picks: number[] = [];
  while (picks.length < size && remaining.length > 0) {
    const total = remaining.reduce(
      (sum, n) => sum + (weights[n] ?? 1),
      0,
    );
    let threshold = rng() * total;
    let chosenIdx = remaining.length - 1;
    for (let i = 0; i < remaining.length; i += 1) {
      threshold -= weights[remaining[i]] ?? 1;
      if (threshold <= 0) {
        chosenIdx = i;
        break;
      }
    }
    picks.push(remaining[chosenIdx]);
    remaining.splice(chosenIdx, 1);
  }
  return picks.sort((a, b) => a - b);
}
