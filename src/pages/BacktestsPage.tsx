/**
 * Backtests: run multi-strategy sims against historical windows and
 * export the result as JSON or CSV.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Play } from "lucide-react";
import { useEffect, useState } from "react";

import { runBacktest } from "@/domain/backtesting";
import type { DrawRecord, StrategyName } from "@/domain/scoring";
import {
  exportBacktest,
  listBacktests,
  listDraws,
  saveBacktest,
  type BacktestRunDto,
  type DrawDto,
} from "@/lib/ipc";
import { strategyLabel, strategyListLabel } from "@/lib/labels";
import { cn } from "@/lib/utils";

const STRATEGIES: { value: StrategyName; label: string; hint: string }[] = [
  {
    value: "balanced",
    label: "平衡",
    hint: "冷热频率、遗漏覆盖、预算利用和近期重复之间取均衡。",
  },
  {
    value: "anti_popular",
    label: "反热门",
    hint: "降低热门与常见选号偏好，观察分散化方案的命中稳定性。",
  },
  {
    value: "recency_fade",
    label: "弱化近期",
    hint: "惩罚最近 3 期重复号码，检验短期回避近期号的效果。",
  },
];

type LotteryType = "ssq" | "dlt";

const DEFAULT_REQUEST_BY_TYPE: Record<LotteryType, string> = {
  ssq: "双色球 20 元 平衡",
  dlt: "大乐透 20 元 追加 平衡",
};

export function BacktestsPage(): JSX.Element {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    lotteryType: "ssq" as LotteryType,
    requestText: DEFAULT_REQUEST_BY_TYPE.ssq,
    startIssue: "",
    endIssue: "",
    strategies: ["balanced", "anti_popular", "recency_fade"] as StrategyName[],
  });
  const [error, setError] = useState<string | null>(null);

  const runsQuery = useQuery({
    queryKey: ["backtests"],
    queryFn: () => listBacktests(10),
  });
  const drawDefaultsQuery = useQuery({
    queryKey: ["draws", form.lotteryType, "backtest-defaults"],
    queryFn: () => listDraws(form.lotteryType, 180),
    staleTime: 30_000,
  });

  useEffect(() => {
    const draws = drawDefaultsQuery.data ?? [];
    if (draws.length < 130 || form.startIssue || form.endIssue) return;
    const sorted = [...draws].sort(
      (a, b) => Number(b.issue) - Number(a.issue),
    );
    setForm((prev) => ({
      ...prev,
      endIssue: sorted[0]?.issue ?? prev.endIssue,
      startIssue: sorted[29]?.issue ?? sorted[sorted.length - 1]?.issue ?? prev.startIssue,
    }));
  }, [drawDefaultsQuery.data, form.endIssue, form.startIssue]);

  const runMutation = useMutation({
    mutationFn: async () => {
      setError(null);
      const draws = await listDraws(form.lotteryType, 1000);
      const history = draws
        .map(drawDtoToRecord)
        .filter((draw): draw is DrawRecord => draw !== null);
      if (history.length < 150) {
        throw new Error(
          `历史开奖不足（当前 ${history.length} 期），无法执行回测。请先同步更多历史。`,
        );
      }
      const result = runBacktest({
        lotteryType: form.lotteryType,
        requestText: form.requestText,
        startIssue: form.startIssue,
        endIssue: form.endIssue,
        strategies: form.strategies,
        history,
      });
      const runId = await saveBacktest({
        lottery_type: form.lotteryType,
        request_text: form.requestText,
        start_issue: form.startIssue,
        end_issue: form.endIssue,
        strategies: form.strategies,
        summary: result.summary as unknown as Record<string, unknown>,
        config_snapshot: result.configSnapshot,
        report_markdown: result.reportMarkdown,
        samples: result.samples.map((sample) => ({
          strategy_name: sample.strategy_name,
          issue: sample.issue,
          generated_numbers: sample.generated_numbers,
          actual_numbers: sample.actual_numbers,
          score_snapshot: sample.score_snapshot,
          hit_summary: sample.hit_summary,
        })),
      });
      return runId;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["backtests"] });
    },
    onError: (err: Error) => {
      setError(err.message);
    },
  });

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-2xl font-semibold tracking-tight">回测</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          在历史期号区间内跑多策略对比，支持数据与表格导出。
        </p>
      </header>

      <section className="rounded-lg border border-border bg-card/60 p-4 text-sm">
        <h3 className="font-semibold">回测方法</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          使用滚动窗口回测：每一期只使用该期开奖之前的历史数据生成候选，再与真实开奖号对比，避免“偷看未来数据”。
          排名优先看投入归一后的命中效率，其次看至少命中比例和平均评分。
        </p>
      </section>

      <form
        className="space-y-4 rounded-lg border border-border p-5"
        onSubmit={(event) => {
          event.preventDefault();
          runMutation.mutate();
        }}
      >
        <div className="grid gap-4 md:grid-cols-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">彩种</span>
            <select
              value={form.lotteryType}
              onChange={(event) => {
                const lotteryType = event.target.value as LotteryType;
                setForm((prev) => ({
                  ...prev,
                  lotteryType,
                  requestText:
                    prev.requestText === DEFAULT_REQUEST_BY_TYPE[prev.lotteryType]
                      ? DEFAULT_REQUEST_BY_TYPE[lotteryType]
                      : prev.requestText,
                  startIssue: "",
                  endIssue: "",
                }));
              }}
              className="rounded-md border border-border bg-background px-2 py-1.5"
            >
              <option value="ssq">双色球</option>
              <option value="dlt">大乐透</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm md:col-span-2">
            <span className="text-muted-foreground">需求描述</span>
            <input
              value={form.requestText}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, requestText: event.target.value }))
              }
              className="rounded-md border border-border bg-background px-2 py-1.5"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">起始期号</span>
            <input
              value={form.startIssue}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, startIssue: event.target.value }))
              }
              placeholder="2024001"
              className="rounded-md border border-border bg-background px-2 py-1.5"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">结束期号</span>
            <input
              value={form.endIssue}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, endIssue: event.target.value }))
              }
              placeholder="2024050"
              className="rounded-md border border-border bg-background px-2 py-1.5"
            />
          </label>
        </div>
        <fieldset className="space-y-2">
          <legend className="text-sm text-muted-foreground">策略</legend>
          <div className="grid gap-2 md:grid-cols-3">
            {STRATEGIES.map((strategy) => {
              const checked = form.strategies.includes(strategy.value);
              return (
                <label
                  key={strategy.value}
                  className={cn(
                    "flex cursor-pointer flex-col gap-1 rounded-md border border-border px-3 py-2 text-sm",
                    checked && "bg-accent",
                  )}
                >
                  <span className="flex items-center gap-2 font-medium">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5"
                      checked={checked}
                      onChange={(event) => {
                        setForm((prev) => ({
                          ...prev,
                          strategies: event.target.checked
                            ? ([...prev.strategies, strategy.value] as StrategyName[])
                            : prev.strategies.filter((name) => name !== strategy.value),
                        }));
                      }}
                    />
                    {strategy.label}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {strategy.hint}
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
        <div className="flex items-center justify-between">
          <div className="text-xs text-muted-foreground">
            {runMutation.isPending && "回测运行中…"}
          </div>
          <button
            type="submit"
            disabled={
              runMutation.isPending ||
              form.strategies.length === 0 ||
              !form.startIssue ||
              !form.endIssue
            }
            className={cn(
              "inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground",
              "disabled:opacity-60 disabled:cursor-not-allowed",
              "hover:bg-primary/90 transition-colors",
            )}
          >
            <Play className="h-4 w-4" aria-hidden />
            运行回测
          </button>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </form>

      <section className="space-y-3">
        <h3 className="text-lg font-semibold">历史回测</h3>
        {runsQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">读取历史回测…</p>
        ) : (runsQuery.data ?? []).length === 0 ? (
          <p className="rounded-md border border-dashed border-border p-6 text-sm text-muted-foreground">
            暂无回测记录。
          </p>
        ) : (
          <ul className="space-y-3">
            {(runsQuery.data ?? []).map((run) => (
              <RunRow key={run.id} run={run} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function RunRow({ run }: { run: BacktestRunDto }): JSX.Element {
  const summary = run.summary as {
    rankings?: Array<{
      strategy: string;
      sample_count: number;
      primary_hits_total: number;
      secondary_hits_total: number;
      any_hit_rate?: number;
      avg_primary_hits?: number;
      avg_secondary_hits?: number;
      avg_score: number;
      total_spend?: number;
      spend_per_sample?: number;
      hit_efficiency?: number;
    }>;
  };
  const rankings = summary.rankings ?? [];
  const download = async (format: "json" | "csv") => {
    const payload = await exportBacktest(run.id, format);
    const blob = new Blob([new Uint8Array(payload.bytes)], {
      type: payload.mime,
    });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = payload.filename;
    link.click();
    URL.revokeObjectURL(link.href);
  };
  return (
    <li className="space-y-3 rounded-md border border-border p-4">
      <header className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="text-sm font-medium">
            {run.lottery_type === "ssq" ? "双色球" : "大乐透"} ·{" "}
            {run.start_issue} → {run.end_issue}
          </div>
          <div className="text-xs text-muted-foreground">
            {run.request_text} · 策略 {strategyListLabel(run.strategies)} · 样本 {run.sample_count}
          </div>
          <div className="text-xs text-muted-foreground">
            {run.created_at}
          </div>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => download("json")}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
          >
            <Download className="h-3 w-3" aria-hidden /> 导出数据
          </button>
          <button
            type="button"
            onClick={() => download("csv")}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
          >
            <Download className="h-3 w-3" aria-hidden /> 导出表格
          </button>
        </div>
      </header>
      {rankings.length > 0 && (
        <table className="w-full text-xs">
          <thead className="text-muted-foreground">
            <tr>
              <th className="text-left">策略</th>
              <th className="text-right">样本</th>
              <th className="text-right">至少命中率</th>
              <th className="text-right">主区均值</th>
              <th className="text-right">副区均值</th>
              <th className="text-right">命中效率</th>
              <th className="text-right">平均评分</th>
              <th className="text-right">总投入</th>
            </tr>
          </thead>
          <tbody>
            {rankings.map((row) => (
              <tr key={row.strategy} className="border-t border-border">
                <td className="py-1.5">{strategyLabel(row.strategy)}</td>
                <td className="py-1.5 text-right">{row.sample_count}</td>
                <td className="py-1.5 text-right">{formatPercent(row.any_hit_rate)}</td>
                <td className="py-1.5 text-right">
                  {formatNumber(row.avg_primary_hits ?? legacyAverage(row.primary_hits_total, row.sample_count))}
                </td>
                <td className="py-1.5 text-right">
                  {formatNumber(row.avg_secondary_hits ?? legacyAverage(row.secondary_hits_total, row.sample_count))}
                </td>
                <td className="py-1.5 text-right">{formatNumber(row.hit_efficiency ?? 0)}</td>
                <td className="py-1.5 text-right">{row.avg_score.toFixed(2)}</td>
                <td className="py-1.5 text-right">{row.total_spend ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </li>
  );
}

function formatPercent(value: number | undefined): string {
  if (typeof value !== "number") return "-";
  return `${value.toFixed(1)}%`;
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : "-";
}

function legacyAverage(total: number, count: number): number {
  return count > 0 ? total / count : 0;
}

function drawDtoToRecord(draw: DrawDto): DrawRecord | null {
  const base = {
    lotteryType: draw.lottery_type,
    issue: draw.issue,
    drawDate: draw.draw_date,
  };
  if (draw.lottery_type === "ssq") {
    const red = draw.numbers.red;
    const blue = draw.numbers.blue;
    if (!red || !blue) return null;
    return { ...base, red, blue };
  }
  const front = draw.numbers.front;
  const back = draw.numbers.back;
  if (!front || !back) return null;
  return { ...base, front, back };
}
