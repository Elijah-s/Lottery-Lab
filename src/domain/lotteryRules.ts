/**
 * Lottery rule versions for SSQ (双色球) and DLT (大乐透).
 *
 * A `LotteryRuleVersion` captures everything the scoring / ticket-math /
 * parsing layers need to know about a ruleset at a given point in time.
 * Rules evolve (e.g. DLT changed payout structure in 2026), so we keep
 * an ordered list per lottery type and pick the version effective on a
 * target date.
 */

export type LotteryType = "ssq" | "dlt";

export type PlayMode = "single" | "multiple" | "danTuo";

export interface LotteryRuleVersion {
  lotteryType: LotteryType;
  ruleVersion: string;
  /** ISO date `YYYY-MM-DD`. */
  effectiveFrom: string;
  /** Inclusive range for the primary area numbers (SSQ reds / DLT fronts). */
  primaryRange: readonly [number, number];
  /** Inclusive range for the secondary area (SSQ blues / DLT backs). */
  secondaryRange: readonly [number, number];
  primaryPick: number;
  secondaryPick: number;
  basePrice: number;
  extraPrice: number;
  supportsAdditional: boolean;
  maxMultiplier: number;
  maxTicketAmount: number;
}

export const SSQ_RULES: LotteryRuleVersion = {
  lotteryType: "ssq",
  ruleVersion: "ssq-2018-10-12",
  effectiveFrom: "2018-10-12",
  primaryRange: [1, 33],
  secondaryRange: [1, 16],
  primaryPick: 6,
  secondaryPick: 1,
  basePrice: 2,
  extraPrice: 0,
  supportsAdditional: false,
  maxMultiplier: 99,
  maxTicketAmount: 20000,
};

export const DLT_RULES: readonly LotteryRuleVersion[] = [
  {
    lotteryType: "dlt",
    ruleVersion: "dlt-2019-02-20",
    effectiveFrom: "2019-02-20",
    primaryRange: [1, 35],
    secondaryRange: [1, 12],
    primaryPick: 5,
    secondaryPick: 2,
    basePrice: 2,
    extraPrice: 1,
    supportsAdditional: true,
    maxMultiplier: 99,
    maxTicketAmount: 30000,
  },
  {
    lotteryType: "dlt",
    ruleVersion: "dlt-2026-02-02",
    effectiveFrom: "2026-02-02",
    primaryRange: [1, 35],
    secondaryRange: [1, 12],
    primaryPick: 5,
    secondaryPick: 2,
    basePrice: 2,
    extraPrice: 1,
    supportsAdditional: true,
    maxMultiplier: 99,
    maxTicketAmount: 30000,
  },
];

function formatIsoDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Returns the rule version effective on `onDate` (defaults to today).
 *
 * SSQ currently has a single version; the `onDate` check is a no-op
 * there and kept for API symmetry with DLT.
 */
export function getRuleVersion(
  lotteryType: LotteryType,
  onDate?: Date,
): LotteryRuleVersion {
  const iso = formatIsoDate(onDate ?? new Date());

  if (lotteryType === "ssq") {
    if (iso < SSQ_RULES.effectiveFrom) {
      throw new Error(
        `No SSQ rule version available for date ${iso} (earliest: ${SSQ_RULES.effectiveFrom}).`,
      );
    }
    return SSQ_RULES;
  }

  if (lotteryType !== "dlt") {
    throw new Error(`Unsupported lottery type: ${String(lotteryType)}`);
  }

  const sorted = [...DLT_RULES].sort((a, b) =>
    a.effectiveFrom.localeCompare(b.effectiveFrom),
  );
  let active: LotteryRuleVersion | null = null;
  for (const candidate of sorted) {
    if (candidate.effectiveFrom <= iso) {
      active = candidate;
    }
  }
  if (!active) {
    throw new Error(
      `No DLT rule version available for date ${iso} (earliest: ${sorted[0].effectiveFrom}).`,
    );
  }
  return active;
}

/**
 * Human-readable rule notes per play mode. Used for showing the user
 * what a given play-mode actually means at the rules-version level.
 */
export function getRuleNotes(
  lotteryType: LotteryType,
): Record<PlayMode, string> {
  if (lotteryType === "ssq") {
    return {
      single: "单式：6 红 + 1 蓝，每注 2 元。",
      multiple: "复式：按拆解后的单式注数计费，双色球没有追加投注。",
      danTuo: "胆拖：红胆 + 红拖 + 蓝球单选/复选，红胆最多 5 个。",
    };
  }
  return {
    single: "单式：前区 5 个 + 后区 2 个，每注 2 元。",
    multiple: "复式：按拆解后的单式注数计费，可选追加，每注额外 +1 元。",
    danTuo: "胆拖：前区胆拖 + 后区胆拖。追加只影响金额与奖金说明。",
  };
}
