/**
 * Natural-language recommendation panel.
 *
 * Flow:
 * 1. User types a free-form request ("双色球 20 元稳一点").
 * 2. TS layer parses it into a `ParsedRequest`.
 * 3. Pulls validated history from SQLite via `list_draws`.
 * 4. Generates ranked candidates (`generateCandidates`).
 * 5. Ships the top candidate + context to Rust for LLM-backed analysis.
 * 6. Persisted recommendation comes back and renders inline.
 */

import { useMutation } from "@tanstack/react-query";
import { Plus, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { getRuleVersion } from "@/domain/lotteryRules";
import { parseUserRequest, type ParsedRequest } from "@/domain/parsing";
import {
  generateCandidates,
  type CandidateBundle,
} from "@/domain/recommendation";
import {
  buildFrequencyProfile,
  type AreaKey,
  type DrawRecord,
  type FrequencyEntry,
} from "@/domain/scoring";
import type { Ticket } from "@/domain/ticketMath";
import {
  createRecommendation,
  listDraws,
  type DrawDto,
  type RecommendationOutput,
} from "@/lib/ipc";
import { toneLabel } from "@/lib/labels";
import { cn } from "@/lib/utils";

const PRESET_STORAGE_KEY = "lottery-lab.recommendation-presets.v1";

interface RequestPreset {
  id: string;
  label: string;
  text: string;
}

export function RecommendationPanel(): JSX.Element {
  const [userRequest, setUserRequest] = useState("");
  const [result, setResult] = useState<RecommendationOutput | null>(null);
  const [presets, setPresets] = useState<RequestPreset[]>([]);
  const [presetForm, setPresetForm] = useState({ label: "", text: "" });

  useEffect(() => {
    setPresets(loadPresets());
  }, []);

  const mutation = useMutation({
    mutationFn: async (text: string) => runPipeline(text),
    onSuccess: (payload) => setResult(payload),
  });

  return (
    <section className="space-y-4 rounded-lg border border-border p-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">生成推荐</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            用自然语言描述需求，本地评分后由智能模型生成解释。
          </p>
        </div>
        <button
          type="button"
          onClick={() => mutation.mutate(userRequest)}
          disabled={mutation.isPending || userRequest.trim().length === 0}
          className={cn(
            "inline-flex shrink-0 items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground",
            "disabled:opacity-60 disabled:cursor-not-allowed",
            "hover:bg-primary/90 transition-colors",
          )}
        >
          <Sparkles className="h-4 w-4" aria-hidden />
          生成推荐
        </button>
      </header>

      <div className="flex flex-col gap-2">
        <textarea
          value={userRequest}
          onChange={(event) => setUserRequest(event.target.value)}
          placeholder="例如：双色球 20 元稳一点"
          rows={2}
          className={cn(
            "w-full rounded-md border border-border bg-background px-3 py-2 text-sm",
            "focus:outline-none focus:ring-2 focus:ring-ring",
          )}
        />
        <div className="flex flex-wrap items-center gap-2">
          <PresetEditor
            form={presetForm}
            presets={presets}
            onFormChange={setPresetForm}
            onAdd={() => {
              const text = presetForm.text.trim();
              if (!text) return;
              const label = presetForm.label.trim() || makePresetLabel(text);
              const next = [
                ...presets,
                { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, label, text },
              ];
              savePresets(next);
              setPresets(next);
              setPresetForm({ label: "", text: "" });
            }}
            onApply={(text) => setUserRequest(text)}
            onDelete={(id) => {
              const next = presets.filter((preset) => preset.id !== id);
              savePresets(next);
              setPresets(next);
            }}
          />
        </div>
        <div className="flex items-center justify-between">
          <div className="text-xs text-muted-foreground">
            {mutation.isPending && "正在解析 / 抽样 / 请求智能模型…"}
          </div>
        </div>
      </div>

      {mutation.isError && (
        <p className="text-sm text-destructive">
          生成失败：{(mutation.error as Error).message}
        </p>
      )}

      {result && <RecommendationView result={result} />}
    </section>
  );
}

function PresetEditor({
  form,
  presets,
  onFormChange,
  onAdd,
  onApply,
  onDelete,
}: {
  form: { label: string; text: string };
  presets: RequestPreset[];
  onFormChange: (next: { label: string; text: string }) => void;
  onAdd: () => void;
  onApply: (text: string) => void;
  onDelete: (id: string) => void;
}): JSX.Element {
  return (
    <div className="w-full space-y-3 rounded-md border border-border bg-card/50 p-3">
      <div className="grid gap-2 md:grid-cols-[180px_minmax(0,1fr)_auto]">
        <input
          value={form.label}
          onChange={(event) => onFormChange({ ...form, label: event.target.value })}
          placeholder="预设名称"
          className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
        />
        <input
          value={form.text}
          onChange={(event) => onFormChange({ ...form, text: event.target.value })}
          placeholder="输入要保存的需求，例如：双色球 20 元 稳健"
          className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
        />
        <button
          type="button"
          onClick={onAdd}
          disabled={form.text.trim().length === 0}
          className={cn(
            "inline-flex items-center justify-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm",
            "hover:bg-accent hover:text-accent-foreground transition-colors",
            "disabled:opacity-60 disabled:cursor-not-allowed",
          )}
        >
          <Plus className="h-4 w-4" aria-hidden />
          添加预设
        </button>
      </div>

      {presets.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {presets.map((preset) => (
            <span
              key={preset.id}
              className="inline-flex max-w-full items-center rounded-full border border-border bg-background text-xs"
            >
              <button
                type="button"
                className="max-w-[260px] truncate px-3 py-1 text-muted-foreground hover:text-foreground"
                title={preset.text}
                onClick={() => onApply(preset.text)}
              >
                {preset.label}
              </button>
              <button
                type="button"
                className="border-l border-border px-2 py-1 text-muted-foreground hover:text-destructive"
                title="删除预设"
                onClick={() => onDelete(preset.id)}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          暂无自定义预设。添加后可一键填入上方需求。
        </p>
      )}
    </div>
  );
}

function RecommendationView({ result }: { result: RecommendationOutput }): JSX.Element {
  const offlineMessage =
    result.analysis.error && result.analysis.error.trim().length > 0
      ? "智能解释调用失败，已回退为本地摘要。可在「设置」测试连接并调整模型或接口地址。"
      : "智能解释当前为离线摘要。填写接口密钥后重新生成可获得多专家解释。";

  return (
    <article className="space-y-3 rounded-md border border-border bg-card/40 p-4">
      <header className="space-y-1">
        <h4 className="text-base font-semibold">
          {result.ticket_text}
        </h4>
        <p className="text-xs text-muted-foreground">
          目标期号 {result.target_issue} · {result.stake_amount} 元 · 评分 {result.heuristic_score.toFixed(2)}
          {" "}· 策略 {toneLabel(result.parsed_request.tone as string)}
        </p>
      </header>
      <div className="prose prose-sm max-w-none whitespace-pre-wrap text-sm">
        {result.analysis.markdown}
      </div>
      {result.analysis.source_mode === "offline" && (
        <p className="text-xs text-amber-700">
          {offlineMessage}
        </p>
      )}
    </article>
  );
}

function loadPresets(): RequestPreset[] {
  try {
    const raw = window.localStorage.getItem(PRESET_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as RequestPreset[];
    return Array.isArray(parsed)
      ? parsed.filter((item) => item.id && item.label && item.text)
      : [];
  } catch {
    return [];
  }
}

function savePresets(presets: RequestPreset[]) {
  window.localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(presets));
}

function makePresetLabel(text: string): string {
  return text.length > 16 ? `${text.slice(0, 16)}...` : text;
}

async function runPipeline(rawText: string): Promise<RecommendationOutput> {
  const text = rawText.trim();
  if (!text) throw new Error("请输入自然语言需求。");

  const parsed = parseUserRequest(text);
  if (parsed.issues.length > 0) {
    console.warn("parse issues:", parsed.issues);
  }

  const draws = await listDraws(parsed.lotteryType, 200);
  const history: DrawRecord[] = draws
    .map(drawDtoToRecord)
    .filter((draw): draw is DrawRecord => draw !== null);
  if (history.length < 100) {
    throw new Error(
      `当前历史开奖不足 100 期（已同步 ${history.length} 期）。请先在仪表板点「立即同步」。`,
    );
  }

  const bundle = generateCandidates(parsed, history);
  return submitToRust(parsed, history, bundle);
}

function drawDtoToRecord(draw: DrawDto): DrawRecord | null {
  const base: DrawRecord = {
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

async function submitToRust(
  parsed: ParsedRequest,
  history: readonly DrawRecord[],
  bundle: CandidateBundle,
): Promise<RecommendationOutput> {
  const rule = getRuleVersion(parsed.lotteryType);
  const recommendedNumbers = ticketToPayload(bundle.topCandidate.ticket);
  const candidateSnapshot = {
    strategy: bundle.strategy,
    top_score: bundle.topCandidate.scoreSnapshot.score,
    candidate_count: bundle.candidates.length,
    top_candidates: bundle.candidates.map((candidate) => ({
      ticket: ticketToPayload(candidate.ticket),
      amount: candidate.amount,
      formatted: candidate.formatted,
      score: candidate.scoreSnapshot.score,
      breakdown: candidate.scoreSnapshot.breakdown,
    })),
    rule_version: rule.ruleVersion,
  };

  const latestIssue = history[0]?.issue ?? "";
  const historySummary = buildHistorySummary(parsed.lotteryType, history, bundle);

  return createRecommendation({
    lottery_type: parsed.lotteryType,
    target_issue: bundle.targetIssue,
    rules_version: rule.ruleVersion,
    user_request: parsed.rawRequest,
    parsed_request: parsedToPayload(parsed),
    ticket_text: bundle.topCandidate.formatted,
    stake_amount: bundle.topCandidate.amount,
    heuristic_score: bundle.topCandidate.scoreSnapshot.score,
    recommended_numbers: recommendedNumbers,
    candidate_snapshot: candidateSnapshot,
    history_summary: historySummary,
    strategy: bundle.strategy,
    history_window_size: bundle.historyWindowSize,
    validated_history_count: bundle.validatedHistoryCount,
    latest_issue: latestIssue,
  });
}

function parsedToPayload(parsed: ParsedRequest): Record<string, unknown> {
  return {
    lottery_type: parsed.lotteryType,
    budget: parsed.budget,
    tone: parsed.tone,
    play_mode: parsed.playMode,
    additional: parsed.additional,
    exploration_mode: parsed.explorationMode,
    raw_request: parsed.rawRequest,
    issues: parsed.issues,
  };
}

function ticketToPayload(ticket: Ticket): Record<string, unknown> {
  return ticket as unknown as Record<string, unknown>;
}

function buildHistorySummary(
  lotteryType: string,
  history: readonly DrawRecord[],
  bundle: CandidateBundle,
): Record<string, unknown> {
  const primaryArea: AreaKey = lotteryType === "ssq" ? "red" : "front";
  const secondaryArea: AreaKey = lotteryType === "ssq" ? "blue" : "back";
  return {
    window_size: history.length,
    latest_issue: history[0]?.issue ?? "",
    latest_draws: history.slice(0, 5).map((draw) => ({
      issue: draw.issue,
      draw_date: draw.drawDate,
      numbers: drawRecordNumbers(draw),
    })),
    frequency_profile: {
      primary_area: primaryArea,
      secondary_area: secondaryArea,
      primary: summarizeProfile(buildFrequencyProfile(history, primaryArea)),
      secondary: summarizeProfile(buildFrequencyProfile(history, secondaryArea)),
    },
    candidate_evidence: {
      selected_ticket: bundle.topCandidate.formatted,
      selected_score: bundle.topCandidate.scoreSnapshot.score,
      score_breakdown: bundle.topCandidate.scoreSnapshot.breakdown,
      compared_candidates: bundle.candidates.slice(0, 5).map((candidate) => ({
        ticket: candidate.formatted,
        amount: candidate.amount,
        score: candidate.scoreSnapshot.score,
        breakdown: candidate.scoreSnapshot.breakdown,
      })),
    },
  };
}

function summarizeProfile(profile: Record<number, FrequencyEntry>) {
  const rows = Object.entries(profile).map(([number, entry]) => ({
    number: Number(number),
    count: entry.count,
    frequency_pct: round2(entry.frequency * 100),
    missing_periods: entry.age,
  }));
  const byHot = [...rows].sort((a, b) => b.count - a.count || a.number - b.number);
  const byCold = [...rows].sort((a, b) => a.count - b.count || b.missing_periods - a.missing_periods);
  const byOverdue = [...rows].sort((a, b) => b.missing_periods - a.missing_periods || a.count - b.count);
  return {
    hot: byHot.slice(0, 8),
    cold: byCold.slice(0, 8),
    overdue: byOverdue.slice(0, 8),
  };
}

function drawRecordNumbers(draw: DrawRecord): Record<string, number[]> {
  if (draw.lotteryType === "ssq") {
    return { red: draw.red ?? [], blue: draw.blue ?? [] };
  }
  return { front: draw.front ?? [], back: draw.back ?? [] };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
