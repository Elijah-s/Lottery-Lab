/**
 * Sync status + manual trigger card.
 *
 * Shows the most recent sync run per lottery type plus a button that
 * forces an immediate sync. React Query caches the results and
 * invalidates them when the sync mutation completes.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, AlertTriangle, CheckCircle2 } from "lucide-react";
import { useState } from "react";

import {
  type DrawDto,
  type LotterySyncSummary,
  type SyncRunDto,
  type SyncSummary,
  listDraws,
  listSyncRuns,
  syncDraws,
} from "@/lib/ipc";
import { sourceLabel } from "@/lib/labels";
import { cn } from "@/lib/utils";

const LOTTERY_LABELS: Record<string, string> = {
  ssq: "双色球",
  dlt: "大乐透",
};
const DEFAULT_SYNC_LIMIT = "300";
const MIN_SYNC_LIMIT = 1;
const MAX_SYNC_LIMIT = 1000;

function SourceBadge({ attempt }: { attempt: LotterySyncSummary }): JSX.Element {
  const { status, degraded } = attempt;
  const Icon = status === "failed" ? AlertTriangle : CheckCircle2;
  const failed = status === "failed";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs",
        failed
          ? "bg-destructive/10 text-destructive"
          : degraded
          ? "bg-amber-100 text-amber-900"
          : "bg-emerald-100 text-emerald-900",
      )}
    >
      <Icon className="h-3 w-3" aria-hidden />
      {statusLabel(status)}
      {!failed && (
        <span className="opacity-70">· {degraded ? "备用源" : "官方源"}</span>
      )}
    </span>
  );
}

function LotteryRow({
  summary,
  latestDraws,
}: {
  summary: LotterySyncSummary;
  latestDraws: DrawDto[];
}): JSX.Element {
  const selectedAttempt = selectedSourceAttempt(summary);
  const usableCount = selectedAttempt?.valid_count ?? summary.total_fetched;
  const sourceKind = summary.degraded ? "备用源" : "官方源";
  const insertedText =
    summary.status === "synced"
      ? `本次新增 ${summary.inserted_count} 期`
      : "本地已是最新";

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3">
      <div className="flex items-center justify-between">
        <span className="font-medium">
          {LOTTERY_LABELS[summary.lottery_type] ?? summary.lottery_type}
        </span>
        <SourceBadge attempt={summary} />
      </div>
      {summary.status !== "failed" ? (
        <>
          <div className="text-xs text-muted-foreground">
            可用开奖 {usableCount} 期 · {insertedText}
          </div>
          <div className="text-xs text-muted-foreground">
            来源：{sourceLabel(summary.source_name)}（{sourceKind}）
          </div>
        </>
      ) : (
        <div className="text-xs text-destructive">
          同步失败 · 未获得可用开奖
        </div>
      )}
      {summary.status === "failed" && summary.error_summary && (
        <div className="text-xs text-destructive">
          {summary.error_summary}
        </div>
      )}
      {summary.status !== "failed" && summary.degraded && (
        <div className="text-xs text-amber-700">
          官方源暂不可用；已用备用源获取到 {usableCount} 期，功能可正常使用。
        </div>
      )}
      <LatestDraws lotteryType={summary.lottery_type} draws={latestDraws} />
    </div>
  );
}

export function SyncStatusCard(): JSX.Element {
  const queryClient = useQueryClient();
  const [lastSummary, setLastSummary] = useState<SyncSummary | null>(null);
  const [syncLimit, setSyncLimit] = useState(DEFAULT_SYNC_LIMIT);

  const runsQuery = useQuery({
    queryKey: ["sync-runs"],
    queryFn: () => listSyncRuns(6),
    staleTime: 10_000,
  });
  const ssqDrawsQuery = useQuery({
    queryKey: ["draws", "ssq", "latest-preview"],
    queryFn: () => listDraws("ssq", 5),
    staleTime: 30_000,
  });
  const dltDrawsQuery = useQuery({
    queryKey: ["draws", "dlt", "latest-preview"],
    queryFn: () => listDraws("dlt", 5),
    staleTime: 30_000,
  });

  const mutation = useMutation({
    mutationFn: (limit: number) => syncDraws(limit),
    onSuccess: (summary) => {
      setLastSummary(summary);
      queryClient.invalidateQueries({ queryKey: ["sync-runs"] });
      queryClient.invalidateQueries({ queryKey: ["draws"] });
    },
  });

  const latestSummary = lastSummary ?? summaryFromRuns(runsQuery.data ?? []);
  const parsedSyncLimit = parseSyncLimit(syncLimit);

  return (
    <section className="space-y-4 rounded-lg border border-border p-5">
      <header className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <h3 className="text-lg font-semibold">历史开奖同步</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            启动时自动同步；也可手动触发。官方源失败时会尝试备用源。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm">
            <span className="whitespace-nowrap text-muted-foreground">拉取期数</span>
            <input
              type="number"
              min={MIN_SYNC_LIMIT}
              max={MAX_SYNC_LIMIT}
              step={1}
              value={syncLimit}
              onChange={(event) => setSyncLimit(event.target.value)}
              className="h-9 w-24 rounded-md border border-border bg-background px-2 text-sm"
            />
          </label>
          <span className="text-xs text-muted-foreground">1-1000</span>
          <button
            type="button"
            className={cn(
              "inline-flex h-9 items-center gap-2 rounded-md border border-border px-3 text-sm",
              "hover:bg-accent hover:text-accent-foreground transition-colors",
              mutation.isPending && "opacity-60 cursor-wait",
            )}
            onClick={() => {
              if (parsedSyncLimit !== null) {
                mutation.mutate(parsedSyncLimit);
              }
            }}
            disabled={mutation.isPending || parsedSyncLimit === null}
          >
            <RefreshCw
              className={cn("h-4 w-4", mutation.isPending && "animate-spin")}
              aria-hidden
            />
            {mutation.isPending ? "同步中…" : "立即同步"}
          </button>
        </div>
      </header>

      {latestSummary ? (
        <div className="grid gap-3 md:grid-cols-2">
          <LotteryRow
            summary={latestSummary.ssq}
            latestDraws={ssqDrawsQuery.data ?? []}
          />
          <LotteryRow
            summary={latestSummary.dlt}
            latestDraws={dltDrawsQuery.data ?? []}
          />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {runsQuery.isLoading ? "读取同步状态…" : "尚无同步记录。"}
        </p>
      )}

      {mutation.isError && (
        <p className="text-sm text-destructive">
          同步失败：{(mutation.error as Error).message}
        </p>
      )}
    </section>
  );
}

function parseSyncLimit(value: string): number | null {
  const limit = Number(value);
  if (!Number.isInteger(limit)) return null;
  if (limit < MIN_SYNC_LIMIT || limit > MAX_SYNC_LIMIT) return null;
  return limit;
}

function LatestDraws({
  lotteryType,
  draws,
}: {
  lotteryType: string;
  draws: DrawDto[];
}): JSX.Element {
  return (
    <div className="mt-1 border-t border-border pt-2">
      <div className="mb-1 text-xs font-medium text-foreground">
        最新 5 期一等奖号码
      </div>
      {draws.length > 0 ? (
        <ul className="space-y-1">
          {draws.slice(0, 5).map((draw) => (
            <li
              key={draw.id}
              className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs"
            >
              <span className="text-muted-foreground">{draw.issue}</span>
              <span className="font-mono">{formatDrawNumbers(lotteryType, draw)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">暂无开奖预览。</p>
      )}
    </div>
  );
}

function summaryFromRuns(runs: SyncRunDto[]): SyncSummary | null {
  if (runs.length === 0) return null;
  const findRun = (type: "ssq" | "dlt") =>
    runs.find((run) => run.lottery_type === type);
  const ssqRun = findRun("ssq");
  const dltRun = findRun("dlt");
  if (!ssqRun || !dltRun) return null;
  return {
    ssq: runToSummary(ssqRun),
    dlt: runToSummary(dltRun),
  };
}

function runToSummary(run: SyncRunDto): LotterySyncSummary {
  const totalFetched = run.attempts.reduce(
    (sum, attempt) => sum + (attempt.fetched_count ?? 0),
    0,
  );
  return {
    lottery_type: run.lottery_type,
    status: run.status,
    degraded: run.degraded,
    source_name: run.source_name,
    source_url: run.source_url,
    inserted_count: run.inserted_count,
    total_fetched: totalFetched,
    attempts: run.attempts,
    error_summary: run.error_summary,
  };
}

function selectedSourceAttempt(summary: LotterySyncSummary) {
  return (
    summary.attempts.find(
      (attempt) =>
        attempt.source_name === summary.source_name &&
        attempt.valid_count > 0,
    ) ??
    summary.attempts
      .filter((attempt) => attempt.valid_count > 0)
      .sort((a, b) => b.valid_count - a.valid_count)[0]
  );
}

function statusLabel(status: string): string {
  switch (status) {
    case "synced":
      return "已同步";
    case "unchanged":
      return "已是最新";
    case "failed":
      return "同步失败";
    default:
      return status;
  }
}

function formatDrawNumbers(lotteryType: string, draw: DrawDto): string {
  if (lotteryType === "ssq") {
    return [
      `红 ${formatNumbers(draw.numbers.red ?? [])}`,
      `蓝 ${formatNumbers(draw.numbers.blue ?? [])}`,
    ].join(" + ");
  }
  return [
    `前区 ${formatNumbers(draw.numbers.front ?? [])}`,
    `后区 ${formatNumbers(draw.numbers.back ?? [])}`,
  ].join(" + ");
}

function formatNumbers(numbers: number[]): string {
  return numbers.map((number) => String(number).padStart(2, "0")).join(" ");
}
