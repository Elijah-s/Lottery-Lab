import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BrainCircuit,
  CalendarDays,
  Database,
  RefreshCw,
  Search,
  ShieldCheck,
  WalletCards,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { ComponentType, ReactNode } from "react";

import {
  createWorldCupBudgetPlan,
  fetchPreMatchIntelligence,
  getWorldCupMatchDetail,
  listWorldCupMatches,
  listWorldCupQueueJobs,
  listWorldCupSourceHealth,
  runMatchPrediction,
  syncReferenceOddsSources,
  syncSportteryWorldCupOdds,
  syncWorldCupSchedule,
  type BudgetPlanDto,
  type EvidenceItemDto,
  type PredictionRunDto,
  type SourceHealthDto,
  type WorldCupMatchDto,
} from "@/lib/ipc";
import { cn } from "@/lib/utils";

type TabKey = "overview" | "matches" | "intel" | "prediction" | "budget" | "sources";

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "overview", label: "总览" },
  { key: "matches", label: "比赛" },
  { key: "intel", label: "情报" },
  { key: "prediction", label: "预测" },
  { key: "budget", label: "预算模拟" },
  { key: "sources", label: "数据源" },
];

const EMPTY_MATCHES: WorldCupMatchDto[] = [];

export function WorldCupPage(): JSX.Element {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<TabKey>("overview");
  const [selectedMatchId, setSelectedMatchId] = useState<number | null>(null);
  const [filter, setFilter] = useState("");
  const [intelQuery, setIntelQuery] = useState("");
  const [budget, setBudget] = useState(100);
  const [riskMode, setRiskMode] = useState("balanced");
  const [statusMessage, setStatusMessage] = useState<string>("");

  const matchesQuery = useQuery({
    queryKey: ["worldcup", "matches"],
    queryFn: listWorldCupMatches,
  });
  const sourceHealthQuery = useQuery({
    queryKey: ["worldcup", "source-health"],
    queryFn: () => listWorldCupSourceHealth(12),
  });
  const queueQuery = useQuery({
    queryKey: ["worldcup", "queue"],
    queryFn: () => listWorldCupQueueJobs(10),
  });

  const matches = matchesQuery.data ?? EMPTY_MATCHES;
  const selectedMatch =
    matches.find((match) => match.id === selectedMatchId) ?? matches[0] ?? null;
  const effectiveMatchId = selectedMatch?.id ?? null;

  const detailQuery = useQuery({
    queryKey: ["worldcup", "match-detail", effectiveMatchId],
    queryFn: () => getWorldCupMatchDetail(effectiveMatchId as number),
    enabled: effectiveMatchId !== null,
  });

  const filteredMatches = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return matches;
    return matches.filter((match) =>
      [
        match.stage,
        match.group_name ?? "",
        match.home_team,
        match.away_team,
        match.city,
        String(match.match_no),
      ]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [filter, matches]);

  const refreshAll = () => {
    void queryClient.invalidateQueries({ queryKey: ["worldcup"] });
  };

  const syncScheduleMutation = useMutation({
    mutationFn: syncWorldCupSchedule,
    onSuccess: (result) => {
      setStatusMessage(result.message);
      refreshAll();
    },
    onError: (error) => setStatusMessage(String(error)),
  });

  const syncOddsMutation = useMutation({
    mutationFn: syncSportteryWorldCupOdds,
    onSuccess: (result) => {
      setStatusMessage(result.message);
      refreshAll();
    },
    onError: (error) => setStatusMessage(String(error)),
  });

  const syncReferenceMutation = useMutation({
    mutationFn: syncReferenceOddsSources,
    onSuccess: (result) => {
      setStatusMessage(result.message);
      refreshAll();
    },
    onError: (error) => setStatusMessage(String(error)),
  });

  const intelligenceMutation = useMutation({
    mutationFn: () =>
      fetchPreMatchIntelligence({
        match_id: effectiveMatchId as number,
        query: intelQuery.trim() || undefined,
      }),
    onSuccess: (result) => {
      setStatusMessage(
        `赛前情报已完成：通过 ${result.accepted_count} 条，合计 ${result.evidence_count} 条。`,
      );
      refreshAll();
      setActiveTab("intel");
    },
    onError: (error) => setStatusMessage(String(error)),
  });

  const predictionMutation = useMutation({
    mutationFn: () =>
      runMatchPrediction({
        match_id: effectiveMatchId as number,
        research_run_id: null,
      }),
    onSuccess: () => {
      setStatusMessage("比赛模拟已生成。");
      refreshAll();
      setActiveTab("prediction");
    },
    onError: (error) => setStatusMessage(String(error)),
  });

  const budgetMutation = useMutation({
    mutationFn: () =>
      createWorldCupBudgetPlan({
        match_id: effectiveMatchId as number,
        prediction_run_id:
          detailQuery.data?.predictions[0]?.id ??
          selectedMatch?.latest_prediction_id ??
          null,
        budget,
        risk_mode: riskMode,
      }),
    onSuccess: (result) => {
      setStatusMessage(
        result.planning_mode === "analysis_only"
          ? "当前没有可校验赔率，已生成仅分析模式。"
          : "预算模拟已生成。",
      );
      refreshAll();
      setActiveTab("budget");
    },
    onError: (error) => setStatusMessage(String(error)),
  });

  const busy =
    syncScheduleMutation.isPending ||
    syncOddsMutation.isPending ||
    syncReferenceMutation.isPending ||
    intelligenceMutation.isPending ||
    predictionMutation.isPending ||
    budgetMutation.isPending;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">世界杯</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            赛事情报、模型模拟和体彩赔率预算模拟，所有结论保留来源与风险边界。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => syncScheduleMutation.mutate()}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-secondary disabled:opacity-60"
          >
            <RefreshCw className="h-4 w-4" />
            同步赛程
          </button>
          <button
            type="button"
            onClick={() => syncOddsMutation.mutate()}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-secondary disabled:opacity-60"
          >
            <ShieldCheck className="h-4 w-4" />
            同步体彩源
          </button>
          <button
            type="button"
            onClick={() => syncReferenceMutation.mutate()}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-secondary disabled:opacity-60"
          >
            <Database className="h-4 w-4" />
            检查备用源
          </button>
        </div>
      </header>

      {statusMessage ? (
        <div className="rounded-md border border-border bg-card px-4 py-3 text-sm text-foreground">
          {statusMessage}
        </div>
      ) : null}

      <div className="grid gap-3 md:grid-cols-4">
        <MetricCard
          icon={CalendarDays}
          label="比赛总数"
          value={matches.length ? `${matches.length} 场` : "未同步"}
        />
        <MetricCard
          icon={Search}
          label="已审查情报"
          value={`${matches.reduce((sum, match) => sum + match.intelligence_count, 0)} 条`}
        />
        <MetricCard
          icon={BrainCircuit}
          label="已生成模拟"
          value={`${matches.filter((match) => match.latest_prediction_id).length} 场`}
        />
        <MetricCard
          icon={WalletCards}
          label="预算模拟"
          value={`${matches.filter((match) => match.latest_plan_id).length} 场`}
        />
      </div>

      <div className="flex flex-wrap gap-2 border-b border-border pb-2">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            className={cn(
              "rounded-md px-3 py-2 text-sm transition-colors",
              activeTab === tab.key
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-secondary hover:text-foreground",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {matches.length === 0 ? (
        <EmptyState
          busy={syncScheduleMutation.isPending}
          onSync={() => syncScheduleMutation.mutate()}
        />
      ) : (
        <div className="grid gap-5 lg:grid-cols-[330px_minmax(0,1fr)]">
          <section className="space-y-3">
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="筛选球队、阶段、城市或场次"
              className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            <div className="max-h-[680px] space-y-2 overflow-auto pr-1">
              {filteredMatches.map((match) => (
                <button
                  type="button"
                  key={match.id}
                  onClick={() => setSelectedMatchId(match.id)}
                  className={cn(
                    "w-full rounded-md border border-border bg-card p-3 text-left text-sm transition-colors hover:bg-secondary",
                    effectiveMatchId === match.id && "border-primary bg-accent",
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="font-medium">
                      {match.match_no}. {match.home_team} vs {match.away_team}
                    </div>
                    <span className="rounded bg-secondary px-2 py-0.5 text-[11px] text-muted-foreground">
                      {match.stage}
                    </span>
                  </div>
                  <div className="mt-2 text-xs text-muted-foreground">
                    {formatTime(match.kickoff_beijing)} · {match.city}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1 text-[11px]">
                    <StatusPill label={`情报 ${match.intelligence_count}`} />
                    {match.latest_prediction_id ? <StatusPill label="已模拟" /> : null}
                    {match.latest_plan_id ? <StatusPill label="有预算" /> : null}
                  </div>
                </button>
              ))}
            </div>
          </section>

          <section className="min-w-0">
            {selectedMatch ? (
              <MatchWorkspace
                activeTab={activeTab}
                match={selectedMatch}
                evidence={detailQuery.data?.evidence ?? []}
                predictions={detailQuery.data?.predictions ?? []}
                budgetPlans={detailQuery.data?.budget_plans ?? []}
                sourceHealth={
                  detailQuery.data?.source_health ?? sourceHealthQuery.data ?? []
                }
                queueCount={queueQuery.data?.length ?? 0}
                intelQuery={intelQuery}
                setIntelQuery={setIntelQuery}
                budget={budget}
                setBudget={setBudget}
                riskMode={riskMode}
                setRiskMode={setRiskMode}
                busy={busy || detailQuery.isFetching}
                onFetchIntel={() => intelligenceMutation.mutate()}
                onPredict={() => predictionMutation.mutate()}
                onBudget={() => budgetMutation.mutate()}
              />
            ) : null}
          </section>
        </div>
      )}
    </div>
  );
}

function MatchWorkspace(props: {
  activeTab: TabKey;
  match: WorldCupMatchDto;
  evidence: EvidenceItemDto[];
  predictions: PredictionRunDto[];
  budgetPlans: BudgetPlanDto[];
  sourceHealth: SourceHealthDto[];
  queueCount: number;
  intelQuery: string;
  setIntelQuery: (value: string) => void;
  budget: number;
  setBudget: (value: number) => void;
  riskMode: string;
  setRiskMode: (value: string) => void;
  busy: boolean;
  onFetchIntel: () => void;
  onPredict: () => void;
  onBudget: () => void;
}): JSX.Element {
  const latestPrediction = props.predictions[0];
  const latestBudget = props.budgetPlans[0];

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-border bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-sm text-muted-foreground">
              第 {props.match.match_no} 场 · {props.match.stage}
            </div>
            <h3 className="mt-1 text-xl font-semibold">
              {props.match.home_team} vs {props.match.away_team}
            </h3>
            <div className="mt-2 flex flex-wrap gap-3 text-sm text-muted-foreground">
              <span>{formatTime(props.match.kickoff_beijing)}</span>
              <span>{props.match.city}</span>
              <span>{props.match.venue}</span>
            </div>
          </div>
          <a
            href={props.match.source_url}
            target="_blank"
            rel="noreferrer"
            className="rounded-md border border-border px-3 py-2 text-sm hover:bg-secondary"
          >
            官方赛程源
          </a>
        </div>
      </div>

      {props.activeTab === "overview" || props.activeTab === "matches" ? (
        <div className="grid gap-3 md:grid-cols-3">
          <InfoPanel title="情报状态" value={`${props.evidence.length} 条`} />
          <InfoPanel
            title="模拟状态"
            value={latestPrediction ? "已生成" : "未生成"}
          />
          <InfoPanel
            title="预算状态"
            value={latestBudget ? planningModeLabel(latestBudget.planning_mode) : "未生成"}
          />
        </div>
      ) : null}

      {props.activeTab === "intel" || props.activeTab === "overview" ? (
        <Panel
          title="赛前情报"
          action={
            <button
              type="button"
              onClick={props.onFetchIntel}
              disabled={props.busy}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
            >
              <Search className="h-4 w-4" />
              获取赛前情报
            </button>
          }
        >
          <textarea
            value={props.intelQuery}
            onChange={(event) => props.setIntelQuery(event.target.value)}
            placeholder="可补充关注点，例如：重点看伤停、预计首发、教练发布会、体彩赔率变化"
            className="min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          <EvidenceList evidence={props.evidence} />
        </Panel>
      ) : null}

      {props.activeTab === "prediction" || props.activeTab === "overview" ? (
        <Panel
          title="比赛模拟"
          action={
            <button
              type="button"
              onClick={props.onPredict}
              disabled={props.busy || props.evidence.length === 0}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
            >
              <BrainCircuit className="h-4 w-4" />
              生成模拟
            </button>
          }
        >
          {latestPrediction ? (
            <PredictionView prediction={latestPrediction} />
          ) : (
            <MutedText>需要先获取并通过审查的赛前情报。</MutedText>
          )}
        </Panel>
      ) : null}

      {props.activeTab === "budget" || props.activeTab === "overview" ? (
        <Panel
          title="预算模拟"
          action={
            <button
              type="button"
              onClick={props.onBudget}
              disabled={props.busy || !latestPrediction}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
            >
              <WalletCards className="h-4 w-4" />
              生成预算模拟
            </button>
          }
        >
          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-sm">
              <span className="text-muted-foreground">预算</span>
              <input
                type="number"
                min={0}
                max={100000}
                value={props.budget}
                onChange={(event) => props.setBudget(Number(event.target.value))}
                className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 outline-none focus:ring-2 focus:ring-ring"
              />
            </label>
            <label className="text-sm">
              <span className="text-muted-foreground">风险偏好</span>
              <select
                value={props.riskMode}
                onChange={(event) => props.setRiskMode(event.target.value)}
                className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="conservative">保守</option>
                <option value="balanced">平衡</option>
                <option value="aggressive">激进</option>
              </select>
            </label>
          </div>
          {latestBudget ? <BudgetView plan={latestBudget} /> : <MutedText>没有预算模拟记录。</MutedText>}
        </Panel>
      ) : null}

      {props.activeTab === "sources" || props.activeTab === "overview" ? (
        <Panel title="数据源与队列">
          <div className="mb-3 text-sm text-muted-foreground">
            当前队列任务 {props.queueCount} 个。批量任务默认应限制未来 24/48 小时比赛。
          </div>
          <SourceHealthList items={props.sourceHealth} />
        </Panel>
      ) : null}
    </div>
  );
}

function MetricCard(props: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: string;
}): JSX.Element {
  const Icon = props.icon;
  return (
    <div className="rounded-md border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs text-muted-foreground">{props.label}</div>
          <div className="mt-1 text-lg font-semibold">{props.value}</div>
        </div>
        <Icon className="h-5 w-5 text-primary" />
      </div>
    </div>
  );
}

function Panel(props: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="rounded-md border border-border bg-card p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-lg font-semibold">{props.title}</h3>
        {props.action}
      </div>
      <div className="space-y-4">{props.children}</div>
    </section>
  );
}

function InfoPanel(props: { title: string; value: string }): JSX.Element {
  return (
    <div className="rounded-md border border-border bg-card p-4">
      <div className="text-xs text-muted-foreground">{props.title}</div>
      <div className="mt-1 font-semibold">{props.value}</div>
    </div>
  );
}

function EvidenceList(props: { evidence: EvidenceItemDto[] }): JSX.Element {
  if (props.evidence.length === 0) {
    return <MutedText>还没有赛前情报。点击获取后会先审查再入库。</MutedText>;
  }
  return (
    <div className="space-y-2">
      {props.evidence.slice(0, 8).map((item) => (
        <div key={item.id} className="rounded-md border border-border bg-background p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="font-medium">{item.title}</div>
            <div className="flex gap-1">
              <StatusPill label={sourceLevelLabel(item.source_level)} />
              <StatusPill label={item.audit_status === "accepted" ? "已通过" : "待核验"} />
            </div>
          </div>
          <div className="mt-2 text-xs text-muted-foreground">
            {item.source_name} · 可信度 {(item.credibility * 100).toFixed(0)}% ·{" "}
            {formatTime(item.fetched_at)}
          </div>
        </div>
      ))}
    </div>
  );
}

function PredictionView(props: { prediction: PredictionRunDto }): JSX.Element {
  const probability = props.prediction.final_probability;
  return (
    <div className="space-y-3">
      <div className="grid gap-2 md:grid-cols-3">
        <InfoPanel title="主胜" value={`${toPercent(probability.home_win)}%`} />
        <InfoPanel title="平局" value={`${toPercent(probability.draw)}%`} />
        <InfoPanel title="客胜" value={`${toPercent(probability.away_win)}%`} />
      </div>
      <div className="rounded-md border border-border bg-background p-3 text-sm whitespace-pre-wrap">
        {props.prediction.analysis_markdown}
      </div>
    </div>
  );
}

function BudgetView(props: { plan: BudgetPlanDto }): JSX.Element {
  return (
    <div className="rounded-md border border-border bg-background p-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill label={planningModeLabel(props.plan.planning_mode)} />
        <StatusPill label={`预算 ${props.plan.budget}`} />
        <StatusPill label={`最大亏损 ${props.plan.max_loss}`} />
      </div>
      <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap text-xs leading-5 text-muted-foreground">
        {JSON.stringify(props.plan.plan_json, null, 2)}
      </pre>
    </div>
  );
}

function SourceHealthList(props: { items: SourceHealthDto[] }): JSX.Element {
  if (props.items.length === 0) {
    return <MutedText>还没有数据源检查记录。</MutedText>;
  }
  return (
    <div className="space-y-2">
      {props.items.map((item) => (
        <div key={item.id} className="rounded-md border border-border bg-background p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="font-medium">{item.source_name}</div>
            <div className="flex gap-1">
              <StatusPill label={sourceLevelLabel(item.source_level)} />
              <StatusPill label={sourceStatusLabel(item.status)} />
            </div>
          </div>
          <div className="mt-2 text-sm text-muted-foreground">{item.message}</div>
          <div className="mt-2 text-xs text-muted-foreground">
            覆盖率 {(item.field_coverage * 100).toFixed(0)}% · 失败率{" "}
            {(item.failure_rate * 100).toFixed(0)}% · {formatTime(item.fetched_at)}
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState(props: { busy: boolean; onSync: () => void }): JSX.Element {
  return (
    <div className="rounded-md border border-border bg-card p-8 text-center">
      <CalendarDays className="mx-auto h-8 w-8 text-primary" />
      <h3 className="mt-3 text-lg font-semibold">还没有世界杯赛程</h3>
      <p className="mx-auto mt-2 max-w-lg text-sm text-muted-foreground">
        先同步 2026 世界杯 104 场比赛骨架，再对单场比赛获取赛前情报、生成模拟和预算模拟。
      </p>
      <button
        type="button"
        onClick={props.onSync}
        disabled={props.busy}
        className="mt-4 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
      >
        <RefreshCw className="h-4 w-4" />
        同步世界杯赛程
      </button>
    </div>
  );
}

function StatusPill(props: { label: string }): JSX.Element {
  return (
    <span className="inline-flex items-center rounded bg-secondary px-2 py-0.5 text-[11px] text-secondary-foreground">
      {props.label}
    </span>
  );
}

function MutedText(props: { children: ReactNode }): JSX.Element {
  return <p className="text-sm text-muted-foreground">{props.children}</p>;
}

function sourceLevelLabel(value: string): string {
  if (value === "official") return "官方源";
  if (value === "verified_mirror") return "备用参考";
  if (value === "market_reference") return "市场参考";
  return value || "未知来源";
}

function sourceStatusLabel(value: string): string {
  const labels: Record<string, string> = {
    ok: "正常",
    available: "可访问",
    degraded: "降级",
    failed: "失败",
    no_worldcup_events: "暂无场次",
    not_configured: "未配置",
  };
  return labels[value] ?? value;
}

function planningModeLabel(value: string): string {
  if (value === "official") return "官方预算模拟";
  if (value === "reference_only") return "备用参考草案";
  if (value === "analysis_only") return "仅分析";
  return value;
}

function formatTime(value: string): string {
  return value.replace("T", " ").replace("+08:00", "").replace("Z", "");
}

function toPercent(value: number | undefined): string {
  return ((value ?? 0) * 100).toFixed(1);
}
