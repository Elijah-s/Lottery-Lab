/**
 * Heuristic scoring for candidate tickets.
 *
 * Scores are not a probability claim — they encode how well a candidate
 * matches the user's strategy against the visible historical window.
 * Higher is better, roughly on a 0-100 scale, but without a hard cap:
 * extreme candidates can exceed 100 slightly due to additive bonuses.
 */

import type { LotteryType } from "@/domain/lotteryRules";
import type { Ticket } from "@/domain/ticketMath";

/** A single draw in the historical window used for scoring. */
export interface DrawRecord {
  lotteryType: LotteryType;
  issue: string;
  drawDate: string;
  red?: number[];
  blue?: number[];
  front?: number[];
  back?: number[];
}

export type StrategyName = "balanced" | "anti_popular" | "recency_fade";

export interface ScoreSnapshot {
  score: number;
  breakdown: Record<string, number>;
  strategy: StrategyName;
}

export type AreaKey = "red" | "blue" | "front" | "back";

export interface FrequencyEntry {
  count: number;
  /** Draws since this number last appeared (0 if it appeared in history[0]). */
  age: number;
  /** count / history.length, 0-1. */
  frequency: number;
}

/**
 * Builds a frequency profile for a given area across the history window.
 *
 * `history` is expected to be ordered newest-first (index 0 = latest).
 * Missing numbers (never drawn in the window) still appear via their
 * observed range so downstream scoring can handle them; we only fill
 * entries that actually show up in history here.
 */
export function buildFrequencyProfile(
  history: readonly DrawRecord[],
  areaKey: AreaKey,
): Record<number, FrequencyEntry> {
  const profile: Record<number, FrequencyEntry> = {};
  if (history.length === 0) return profile;

  history.forEach((draw, index) => {
    const bucket = draw[areaKey];
    if (!bucket) return;
    for (const number of bucket) {
      const entry = profile[number] ?? {
        count: 0,
        age: index,
        frequency: 0,
      };
      entry.count += 1;
      if (entry.count === 1) {
        // First time we see this number — distance from "now" is its age.
        entry.age = index;
      } else {
        entry.age = Math.min(entry.age, index);
      }
      profile[number] = entry;
    }
  });

  for (const key of Object.keys(profile)) {
    const entry = profile[Number(key)];
    entry.frequency = entry.count / history.length;
  }
  return profile;
}

function collectTicketNumbers(
  ticket: Ticket,
  primary: boolean,
): number[] {
  if (ticket.lotteryType === "ssq") {
    if (ticket.mode === "single") {
      return primary ? ticket.reds : ticket.blues;
    }
    if (ticket.mode === "multiple") {
      return primary ? ticket.redBank : ticket.blueBank;
    }
    return primary
      ? [...ticket.redDan, ...ticket.redTuo]
      : ticket.blueBank;
  }

  if (ticket.mode === "single") {
    return primary ? ticket.front : ticket.back;
  }
  if (ticket.mode === "multiple") {
    return primary ? ticket.frontBank : ticket.backBank;
  }
  return primary
    ? [...ticket.frontDan, ...ticket.frontTuo]
    : [...ticket.backDan, ...ticket.backTuo];
}

function recentNumbers(
  history: readonly DrawRecord[],
  areaKey: AreaKey,
  depth: number,
): Set<number> {
  const set = new Set<number>();
  history.slice(0, depth).forEach((draw) => {
    const bucket = draw[areaKey];
    if (!bucket) return;
    for (const number of bucket) set.add(number);
  });
  return set;
}

function safeAverage(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

interface ScoreComponents {
  balancedFrequency: number;
  coldCoverage: number;
  budgetUtilization: number;
  strategyBias: number;
}

const WEIGHTS: Record<keyof ScoreComponents, number> = {
  balancedFrequency: 25,
  coldCoverage: 30,
  budgetUtilization: 20,
  strategyBias: 25,
};

/**
 * Scores a single candidate against the provided history window.
 *
 * Returns a snapshot of the score plus the per-factor breakdown so the
 * UI can explain *why* a candidate ranks where it does.
 */
export function scoreCandidate(
  lotteryType: LotteryType,
  ticket: Ticket,
  history: readonly DrawRecord[],
  budget: number,
  amount: number,
  strategy: StrategyName,
): ScoreSnapshot {
  const primaryArea: AreaKey = lotteryType === "ssq" ? "red" : "front";
  const secondaryArea: AreaKey = lotteryType === "ssq" ? "blue" : "back";

  const primaryProfile = buildFrequencyProfile(history, primaryArea);
  const secondaryProfile = buildFrequencyProfile(history, secondaryArea);

  const primaryNumbers = collectTicketNumbers(ticket, true);
  const secondaryNumbers = collectTicketNumbers(ticket, false);

  const freqValues = [
    ...primaryNumbers.map((n) => primaryProfile[n]?.frequency ?? 0),
    ...secondaryNumbers.map((n) => secondaryProfile[n]?.frequency ?? 0),
  ];
  const avgFreq = safeAverage(freqValues);
  // Ideal average frequency lies near "fair" — we reward candidates that
  // neither chase super-hot numbers nor pile entirely on unseen ones.
  const balancedFrequency = clamp01(1 - Math.abs(avgFreq - 0.18) * 3);

  const ageValues = [
    ...primaryNumbers.map((n) => primaryProfile[n]?.age ?? history.length),
    ...secondaryNumbers.map((n) => secondaryProfile[n]?.age ?? history.length),
  ];
  const avgAge = safeAverage(ageValues);
  const coldCoverage = clamp01(Math.min(avgAge, 12) / 12);

  const budgetUtilization = budget > 0
    ? clamp01(amount / Math.max(budget, 1))
    : 0;

  const strategyBias = computeStrategyBias(
    strategy,
    primaryNumbers,
    secondaryNumbers,
    lotteryType,
    history,
  );

  const components: ScoreComponents = {
    balancedFrequency,
    coldCoverage,
    budgetUtilization,
    strategyBias,
  };

  const score =
    components.balancedFrequency * WEIGHTS.balancedFrequency +
    components.coldCoverage * WEIGHTS.coldCoverage +
    components.budgetUtilization * WEIGHTS.budgetUtilization +
    components.strategyBias * WEIGHTS.strategyBias;

  return {
    score: round2(score),
    breakdown: {
      balancedFrequency: round2(components.balancedFrequency),
      coldCoverage: round2(components.coldCoverage),
      budgetUtilization: round2(components.budgetUtilization),
      strategyBias: round2(components.strategyBias),
    },
    strategy,
  };
}

function computeStrategyBias(
  strategy: StrategyName,
  primaryNumbers: number[],
  secondaryNumbers: number[],
  lotteryType: LotteryType,
  history: readonly DrawRecord[],
): number {
  if (strategy === "balanced") {
    return 0.5;
  }
  if (strategy === "anti_popular") {
    const highPrimary = primaryNumbers.filter((n) => n > 25).length;
    const evenSecondary = secondaryNumbers.filter((n) => n % 2 === 0).length;
    const primaryShare = primaryNumbers.length
      ? highPrimary / primaryNumbers.length
      : 0;
    const secondaryShare = secondaryNumbers.length
      ? evenSecondary / secondaryNumbers.length
      : 0;
    return clamp01(primaryShare * 0.7 + secondaryShare * 0.3);
  }
  // recency_fade: penalize overlap with the most recent draws.
  const primaryArea: AreaKey = lotteryType === "ssq" ? "red" : "front";
  const secondaryArea: AreaKey = lotteryType === "ssq" ? "blue" : "back";
  const recentPrimary = recentNumbers(history, primaryArea, 3);
  const recentSecondary = recentNumbers(history, secondaryArea, 3);
  const overlapPrimary = primaryNumbers.filter((n) =>
    recentPrimary.has(n),
  ).length;
  const overlapSecondary = secondaryNumbers.filter((n) =>
    recentSecondary.has(n),
  ).length;
  const total = primaryNumbers.length + secondaryNumbers.length;
  if (total === 0) return 0.5;
  const overlap = (overlapPrimary + overlapSecondary) / total;
  return clamp01(1 - overlap);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
