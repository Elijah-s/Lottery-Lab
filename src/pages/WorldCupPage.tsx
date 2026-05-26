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
        <div className="grid gap-5 lg:grid-cols-[360px_minmax(0,1fr)]">
          <section className="space-y-3 lg:sticky lg:top-4 lg:self-start">
            <div className="rounded-md border border-border bg-card p-3">
              <input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="筛选球队、阶段、城市或场次"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
              <div className="mt-2 text-xs text-muted-foreground">
                当前显示 {filteredMatches.length} / {matches.length} 场
              </div>
            </div>
            <div className="max-h-[calc(100vh-270px)] space-y-2 overflow-auto pr-1">
              {filteredMatches.map((match) => (
                <button
                  type="button"
                  key={match.id}
                  onClick={() => setSelectedMatchId(match.id)}
                  className={cn(
                    "w-full rounded-md border border-border bg-card p-3.5 text-left text-sm transition-colors hover:bg-secondary",
                    effectiveMatchId === match.id && "border-primary bg-accent",
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-[11px] text-muted-foreground">
                        第 {match.match_no} 场
                      </div>
                      <div className="mt-1 font-semibold leading-5 text-foreground">
                        {matchTitle(match)}
                      </div>
                    </div>
                    <span className="shrink-0 rounded bg-secondary px-2 py-0.5 text-[11px] text-muted-foreground">
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
  const isOverview = props.activeTab === "overview";

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-border bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-sm text-muted-foreground">
              第 {props.match.match_no} 场 · {props.match.stage}
            </div>
            <h3 className="mt-1 text-xl font-semibold">
              {matchTitle(props.match)}
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

      {isOverview || props.activeTab === "matches" ? (
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

      {isOverview ? (
        <div className="space-y-4">
          <IntelligencePanel
            evidence={props.evidence}
            intelQuery={props.intelQuery}
            setIntelQuery={props.setIntelQuery}
            busy={props.busy}
            onFetchIntel={props.onFetchIntel}
            evidenceLimit={6}
            evidenceMaxClassName="max-h-72"
          />
          <PredictionPanel
            evidenceCount={props.evidence.length}
            prediction={latestPrediction}
            busy={props.busy}
            onPredict={props.onPredict}
          />
          <BudgetPanel
            budget={props.budget}
            setBudget={props.setBudget}
            riskMode={props.riskMode}
            setRiskMode={props.setRiskMode}
            latestPrediction={latestPrediction}
            latestBudget={latestBudget}
            busy={props.busy}
            onBudget={props.onBudget}
          />
          <SourcesPanel
            queueCount={props.queueCount}
            sourceHealth={props.sourceHealth}
            maxClassName="max-h-56"
          />
        </div>
      ) : null}

      {props.activeTab === "intel" ? (
        <IntelligencePanel
          evidence={props.evidence}
          intelQuery={props.intelQuery}
          setIntelQuery={props.setIntelQuery}
          busy={props.busy}
          onFetchIntel={props.onFetchIntel}
          evidenceLimit={12}
          evidenceMaxClassName="max-h-[520px]"
        />
      ) : null}

      {props.activeTab === "prediction" ? (
        <PredictionPanel
          evidenceCount={props.evidence.length}
          prediction={latestPrediction}
          busy={props.busy}
          onPredict={props.onPredict}
        />
      ) : null}

      {props.activeTab === "budget" ? (
        <BudgetPanel
          budget={props.budget}
          setBudget={props.setBudget}
          riskMode={props.riskMode}
          setRiskMode={props.setRiskMode}
          latestPrediction={latestPrediction}
          latestBudget={latestBudget}
          busy={props.busy}
          onBudget={props.onBudget}
        />
      ) : null}

      {props.activeTab === "sources" ? (
        <SourcesPanel
          queueCount={props.queueCount}
          sourceHealth={props.sourceHealth}
          maxClassName="max-h-[520px]"
        />
      ) : null}
    </div>
  );
}

function IntelligencePanel(props: {
  evidence: EvidenceItemDto[];
  intelQuery: string;
  setIntelQuery: (value: string) => void;
  busy: boolean;
  onFetchIntel: () => void;
  evidenceLimit: number;
  evidenceMaxClassName: string;
}): JSX.Element {
  return (
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
      <EvidenceList
        evidence={props.evidence}
        limit={props.evidenceLimit}
        maxClassName={props.evidenceMaxClassName}
      />
    </Panel>
  );
}

function PredictionPanel(props: {
  evidenceCount: number;
  prediction: PredictionRunDto | undefined;
  busy: boolean;
  onPredict: () => void;
}): JSX.Element {
  return (
    <Panel
      title="比赛模拟"
      action={
        <button
          type="button"
          onClick={props.onPredict}
          disabled={props.busy || props.evidenceCount === 0}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
        >
          <BrainCircuit className="h-4 w-4" />
          生成模拟
        </button>
      }
    >
      {props.prediction ? (
        <PredictionView prediction={props.prediction} />
      ) : (
        <MutedText>需要先获取并通过审查的赛前情报。</MutedText>
      )}
    </Panel>
  );
}

function BudgetPanel(props: {
  budget: number;
  setBudget: (value: number) => void;
  riskMode: string;
  setRiskMode: (value: string) => void;
  latestPrediction: PredictionRunDto | undefined;
  latestBudget: BudgetPlanDto | undefined;
  busy: boolean;
  onBudget: () => void;
}): JSX.Element {
  return (
    <Panel
      title="预算模拟"
      action={
        <button
          type="button"
          onClick={props.onBudget}
          disabled={props.busy || !props.latestPrediction}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
        >
          <WalletCards className="h-4 w-4" />
          生成预算模拟
        </button>
      }
    >
      <div className="grid gap-3">
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
      {props.latestBudget ? (
        <BudgetView plan={props.latestBudget} />
      ) : (
        <MutedText>没有预算模拟记录。</MutedText>
      )}
    </Panel>
  );
}

function SourcesPanel(props: {
  queueCount: number;
  sourceHealth: SourceHealthDto[];
  maxClassName: string;
}): JSX.Element {
  return (
    <Panel title="数据源与队列">
      <div className="mb-3 text-sm text-muted-foreground">
        当前队列任务 {props.queueCount} 个。批量任务默认应限制未来 24/48 小时比赛。
      </div>
      <SourceHealthList items={props.sourceHealth} maxClassName={props.maxClassName} />
    </Panel>
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

function EvidenceList(props: {
  evidence: EvidenceItemDto[];
  limit: number;
  maxClassName: string;
}): JSX.Element {
  if (props.evidence.length === 0) {
    return <MutedText>还没有赛前情报。点击获取后会先审查再入库。</MutedText>;
  }
  const visibleEvidence = props.evidence.slice(0, props.limit);
  return (
    <div>
      <div className={cn("space-y-2 overflow-auto pr-1", props.maxClassName)}>
        {visibleEvidence.map((item) => (
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
      {props.evidence.length > visibleEvidence.length ? (
        <div className="mt-2 text-xs text-muted-foreground">
          已显示最近 {visibleEvidence.length} 条，共 {props.evidence.length} 条。
        </div>
      ) : null}
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
      <div className="rounded-md border border-border bg-background p-4">
        <ReadableMarkdown text={props.prediction.analysis_markdown} />
      </div>
    </div>
  );
}

function BudgetView(props: { plan: BudgetPlanDto }): JSX.Element {
  const narrative = budgetNarrative(props.plan);
  return (
    <div className="space-y-3">
      <div className="grid gap-2 md:grid-cols-3">
        <InfoPanel title="模式" value={planningModeLabel(props.plan.planning_mode)} />
        <InfoPanel title="预算" value={formatMoney(props.plan.budget)} />
        <InfoPanel title="最大亏损" value={formatMoney(props.plan.max_loss)} />
      </div>
      <div className="rounded-md border border-border bg-background p-4">
        <ReadableMarkdown text={narrative} />
      </div>
    </div>
  );
}

function ReadableMarkdown(props: { text: string }): JSX.Element {
  const lines = sanitizeMarkdown(props.text).split("\n");
  return (
    <div className="space-y-3 text-sm leading-7 text-foreground">
      {lines.map((line, index) => {
        const trimmed = line.trim();
        if (!trimmed) return null;
        if (trimmed.startsWith("### ")) {
          return (
            <h4 key={index} className="pt-1 text-base font-semibold leading-6">
              {renderInline(trimmed.slice(4))}
            </h4>
          );
        }
        if (trimmed.startsWith("## ")) {
          return (
            <h4 key={index} className="pt-1 text-base font-semibold leading-6">
              {renderInline(trimmed.slice(3))}
            </h4>
          );
        }
        if (trimmed.startsWith("- ")) {
          return (
            <p key={index} className="pl-3 text-muted-foreground">
              <span className="mr-2 text-primary">-</span>
              {renderInline(trimmed.slice(2))}
            </p>
          );
        }
        return <p key={index}>{renderInline(trimmed)}</p>;
      })}
    </div>
  );
}

function SourceHealthList(props: {
  items: SourceHealthDto[];
  maxClassName: string;
}): JSX.Element {
  if (props.items.length === 0) {
    return <MutedText>还没有数据源检查记录。</MutedText>;
  }
  return (
    <div className={cn("space-y-2 overflow-auto pr-1", props.maxClassName)}>
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

function matchTitle(match: WorldCupMatchDto): string {
  return `${match.home_team} 对阵 ${match.away_team}`;
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
  return value.replace("T", " ").replace("+08:00", "").replace("Z", "").replace(/:00$/, "");
}

function toPercent(value: number | undefined): string {
  return ((value ?? 0) * 100).toFixed(1);
}

function formatMoney(value: number): string {
  return value > 0 ? value.toFixed(2).replace(/\.00$/, "") : "0";
}

function budgetNarrative(plan: BudgetPlanDto): string {
  const narrative = stringField(plan.plan_json, "narrative_markdown");
  if (narrative) return narrative;
  if (plan.planning_mode === "official") {
    return `### 状态判断\n当前预算模拟基于官方体彩赔率快照生成。\n\n### 预算边界\n预算 ${formatMoney(plan.budget)}，最大亏损 ${formatMoney(plan.max_loss)}，期望收益估算 ${formatMoney(plan.expected_value)}。\n\n### 风险提示\n足球赛果受阵容、伤停、临场状态和赔率变化影响，本模拟不构成购彩建议。`;
  }
  if (plan.planning_mode === "reference_only") {
    return `### 状态判断\n当前仅有备用参考源，不能当作官方赔率。\n\n### 预算边界\n预算 ${formatMoney(plan.budget)} 只用于本地模拟，执行前必须回到官方渠道核验。\n\n### 风险提示\n备用参考存在延迟或映射错误风险，本模拟不构成购彩建议。`;
  }
  return "### 状态判断\n当前没有可校验的体彩赔率快照。\n\n### 预算边界\n本场仅保留赛事分析，不输出金额分配。\n\n### 风险提示\n足球赛果受阵容、伤停、临场状态和赔率变化影响，本模拟不构成购彩建议。";
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  const item = value[key];
  return typeof item === "string" && item.trim().length > 0 ? item : null;
}

function sanitizeMarkdown(text: string): string {
  const cleaned: string[] = [];
  let inJsonFence = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```") && trimmed.toLowerCase().includes("json")) {
      inJsonFence = true;
      continue;
    }
    if (inJsonFence) {
      if (trimmed.startsWith("```")) inJsonFence = false;
      continue;
    }
    if (trimmed.startsWith("概率数据：") || looksLikeProbabilityJson(trimmed)) {
      continue;
    }
    cleaned.push(line);
  }
  return cleaned.join("\n").trim();
}

function looksLikeProbabilityJson(value: string): boolean {
  return (
    value.startsWith("{") &&
    value.endsWith("}") &&
    value.includes("home_win") &&
    value.includes("draw") &&
    value.includes("away_win")
  );
}

function renderInline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}
