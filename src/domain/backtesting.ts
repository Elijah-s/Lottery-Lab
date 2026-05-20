/**
 * Backtest runner (client-side).
 *
 * For each historical issue in `[startIssue, endIssue]`, pretend we
 * only know the draws that happened *before* that issue and generate
 * a recommendation under each requested strategy. Then compare to the
 * actual draw and record a sample.
 *
 * The pipeline reuses `generateCandidates` from the recommendation
 * module so backtest behaviour stays identical to real-time
 * recommendations (modulo the shifted history window).
 */

import { parseUserRequest } from "@/domain/parsing";
import { generateCandidates } from "@/domain/recommendation";
import type { LotteryType } from "@/domain/lotteryRules";
import type { DrawRecord, StrategyName } from "@/domain/scoring";
import type { Ticket } from "@/domain/ticketMath";

const MIN_HISTORY_REQUIRED = 100;

export interface BacktestConfig {
  lotteryType: LotteryType;
  requestText: string;
  startIssue: string;
  endIssue: string;
  strategies: StrategyName[];
  history: readonly DrawRecord[];
}

export interface BacktestSample {
  strategy_name: StrategyName;
  issue: string;
  generated_numbers: Record<string, unknown>;
  actual_numbers: Record<string, number[]>;
  score_snapshot: Record<string, unknown>;
  hit_summary: {
    primary_hits: number;
    secondary_hits: number;
  };
}

export interface BacktestRankingRow {
  strategy: StrategyName;
  sample_count: number;
  skipped_count: number;
  primary_hits_total: number;
  secondary_hits_total: number;
  any_hit_count: number;
  primary_hit_rate: number;
  secondary_hit_rate: number;
  any_hit_rate: number;
  avg_primary_hits: number;
  avg_secondary_hits: number;
  avg_score: number;
  total_spend: number;
  spend_per_sample: number;
  hit_efficiency: number;
}

export interface BacktestSummary {
  sample_count: number;
  skip_count: number;
  rankings: BacktestRankingRow[];
}

export interface BacktestResult {
  summary: BacktestSummary;
  samples: BacktestSample[];
  configSnapshot: Record<string, unknown>;
  reportMarkdown: string;
}

export function runBacktest(config: BacktestConfig): BacktestResult {
  const parsed = {
    ...parseUserRequest(config.requestText),
    lotteryType: config.lotteryType,
  };
  const sorted = [...config.history].sort(
    (a, b) => Number(b.issue) - Number(a.issue),
  );

  const issuesInRange = sorted.filter((draw) => {
    const issue = Number(draw.issue);
    return (
      issue >= Number(config.startIssue) && issue <= Number(config.endIssue)
    );
  });
  if (issuesInRange.length === 0) {
    throw new Error(
      "所选期号区间在当前历史窗口中没有匹配记录，请先同步数据或调整区间。",
    );
  }

  const samples: BacktestSample[] = [];
  let skipCount = 0;
  const rankMap = new Map<StrategyName, BacktestRankingRow>();
  for (const strategy of config.strategies) {
    rankMap.set(strategy, {
      strategy,
      sample_count: 0,
      skipped_count: 0,
      primary_hits_total: 0,
      secondary_hits_total: 0,
      any_hit_count: 0,
      primary_hit_rate: 0,
      secondary_hit_rate: 0,
      any_hit_rate: 0,
      avg_primary_hits: 0,
      avg_secondary_hits: 0,
      avg_score: 0,
      total_spend: 0,
      spend_per_sample: 0,
      hit_efficiency: 0,
    });
  }

  // Iterate oldest → newest so each iteration's "history before this
  // issue" is a contiguous prefix of `sorted`.
  const chronological = [...issuesInRange].reverse();

  for (const draw of chronological) {
    const drawIssue = Number(draw.issue);
    const windowHistory = sorted.filter(
      (item) => Number(item.issue) < drawIssue,
    );
    if (windowHistory.length < MIN_HISTORY_REQUIRED) {
      skipCount += config.strategies.length;
      continue;
    }
    for (const strategy of config.strategies) {
      try {
        const bundle = generateCandidates(parsed, windowHistory, { strategy });
        const candidate = bundle.topCandidate;
        const hits = countHits(draw, candidate.ticket);
        const row = rankMap.get(strategy)!;
        row.sample_count += 1;
        row.primary_hits_total += hits.primary;
        row.secondary_hits_total += hits.secondary;
        if (hits.primary > 0 || hits.secondary > 0) row.any_hit_count += 1;
        row.avg_score += candidate.scoreSnapshot.score;
        row.total_spend += candidate.amount;
        samples.push({
          strategy_name: strategy,
          issue: draw.issue,
          generated_numbers: candidate.ticket as unknown as Record<string, unknown>,
          actual_numbers: asNumberMap(draw),
          score_snapshot: {
            score: candidate.scoreSnapshot.score,
            breakdown: candidate.scoreSnapshot.breakdown,
          },
          hit_summary: {
            primary_hits: hits.primary,
            secondary_hits: hits.secondary,
          },
        });
      } catch (error) {
        const row = rankMap.get(strategy)!;
        row.skipped_count += 1;
        skipCount += 1;
        console.warn(`backtest skip ${strategy}@${draw.issue}:`, error);
      }
    }
  }

  const rankings = [...rankMap.values()].map((row) => enrichRanking(row));
  rankings.sort((a, b) => {
    if (b.hit_efficiency !== a.hit_efficiency) {
      return b.hit_efficiency - a.hit_efficiency;
    }
    if (b.any_hit_rate !== a.any_hit_rate) {
      return b.any_hit_rate - a.any_hit_rate;
    }
    return b.avg_score - a.avg_score;
  });

  const summary: BacktestSummary = {
    sample_count: samples.length,
    skip_count: skipCount,
    rankings,
  };

  const configSnapshot: Record<string, unknown> = {
    lottery_type: config.lotteryType,
    request_text: config.requestText,
    strategies: config.strategies,
    start_issue: config.startIssue,
    end_issue: config.endIssue,
    minimum_history_required: MIN_HISTORY_REQUIRED,
    total_issues_in_range: chronological.length,
  };
  const reportMarkdown = renderMarkdown(config, summary);
  return { summary, samples, configSnapshot, reportMarkdown };
}

function countHits(draw: DrawRecord, ticket: Ticket) {
  const primary = poolForTicket(ticket, true);
  const secondary = poolForTicket(ticket, false);
  const actualPrimary = draw.lotteryType === "ssq" ? draw.red : draw.front;
  const actualSecondary = draw.lotteryType === "ssq" ? draw.blue : draw.back;
  return {
    primary: intersectCount(primary, actualPrimary ?? []),
    secondary: intersectCount(secondary, actualSecondary ?? []),
  };
}

function poolForTicket(ticket: Ticket, primary: boolean): number[] {
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

function intersectCount(a: number[], b: readonly number[]): number {
  const set = new Set(a);
  let count = 0;
  for (const value of b) {
    if (set.has(value)) count += 1;
  }
  return count;
}

function asNumberMap(draw: DrawRecord): Record<string, number[]> {
  if (draw.lotteryType === "ssq") {
    return { red: draw.red ?? [], blue: draw.blue ?? [] };
  }
  return { front: draw.front ?? [], back: draw.back ?? [] };
}

function renderMarkdown(config: BacktestConfig, summary: BacktestSummary): string {
  const lines: string[] = [];
  lines.push(`# 回测报告`);
  lines.push("");
  lines.push(`- 彩种：${config.lotteryType === "ssq" ? "双色球" : "大乐透"}`);
  lines.push(`- 需求：${config.requestText}`);
  lines.push(`- 区间：${config.startIssue} → ${config.endIssue}`);
  lines.push(`- 方法：滚动窗口回测。每期只使用该期开奖之前的历史数据生成候选，再与真实开奖号对比。`);
  lines.push(`- 策略：${config.strategies.map(strategyLabel).join("、")}`);
  lines.push(`- 有效样本：${summary.sample_count} 条，跳过 ${summary.skip_count} 条`);
  lines.push("");
  lines.push(`| 策略 | 样本 | 至少命中率 | 主区均值 | 副区均值 | 命中效率 | 平均评分 | 总投入 |`);
  lines.push(`| --- | --- | --- | --- | --- | --- | --- | --- |`);
  for (const row of summary.rankings) {
    lines.push(
      `| ${strategyLabel(row.strategy)} | ${row.sample_count} | ${row.any_hit_rate.toFixed(1)}% | ${row.avg_primary_hits.toFixed(2)} | ${row.avg_secondary_hits.toFixed(2)} | ${row.hit_efficiency.toFixed(2)} | ${row.avg_score.toFixed(2)} | ${row.total_spend} |`,
    );
  }
  return lines.join("\n");
}

function enrichRanking(row: BacktestRankingRow): BacktestRankingRow {
  if (row.sample_count === 0) return row;
  const avgPrimary = row.primary_hits_total / row.sample_count;
  const avgSecondary = row.secondary_hits_total / row.sample_count;
  const spendPerSample = row.total_spend / row.sample_count;
  const hitWeight = row.primary_hits_total * 2 + row.secondary_hits_total;
  const spendUnit = Math.max(row.total_spend / 100, 1);
  return {
    ...row,
    avg_score: row.avg_score / row.sample_count,
    primary_hit_rate: (row.primary_hits_total / row.sample_count) * 100,
    secondary_hit_rate: (row.secondary_hits_total / row.sample_count) * 100,
    any_hit_rate: (row.any_hit_count / row.sample_count) * 100,
    avg_primary_hits: avgPrimary,
    avg_secondary_hits: avgSecondary,
    spend_per_sample: spendPerSample,
    hit_efficiency: hitWeight / spendUnit,
  };
}

function strategyLabel(strategy: StrategyName): string {
  if (strategy === "anti_popular") return "反热门";
  if (strategy === "recency_fade") return "弱化近期";
  return "平衡";
}
