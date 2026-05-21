/**
 * Prompt editor for the recommendation system roles.
 *
 * Prompts are seeded with defaults on first launch (Rust side) and the
 * UI here simply lets the user edit and save changes back to SQLite.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw, Save } from "lucide-react";
import { useEffect, useState } from "react";

import {
  getPrompts,
  resetPrompts,
  savePrompts,
  type PromptRecord,
} from "@/lib/ipc";
import { cn } from "@/lib/utils";

const ROLE_META: Record<string, { label: string; hint: string }> = {
  selection_director: {
    label: "选号总控",
    hint: "从候选池中选择最终候选 ID，结合历史摘要和复盘反馈。",
  },
  lottery_expert: {
    label: "彩票专家",
    hint: "从彩票规则、历史冷热号角度评估候选池。",
  },
  math_expert: {
    label: "数学专家",
    hint: "评估候选分布、方差、覆盖区间和统计假设。",
  },
  modeler: {
    label: "建模师",
    hint: "关注数据质量、策略偏差和可改进点。",
  },
};

const RUNTIME_PROMPT_PREVIEW = `每次生成推荐时，系统会自动把以下运行时上下文拼入用户消息：

1. 用户自然语言需求、彩种、目标期号、偏好策略。
2. 多策略候选池：候选 ID、票面、金额、本地评分、评分拆解、策略来源。
3. 历史开奖统计摘要：最近 5 期、冷热号、遗漏、候选对比依据。
4. 历史推荐复盘反馈：已复盘样本数、平均命中、命中分布、各策略表现、LLM 覆盖本地最高分后的表现。

模型必须只返回 JSON，并且 selected_id 必须来自候选池；最终号码由本地按候选 ID 回填和校验。`;

export function PromptsPage(): JSX.Element {
  const queryClient = useQueryClient();
  const promptsQuery = useQuery({
    queryKey: ["prompts"],
    queryFn: () => getPrompts(),
  });
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    if (promptsQuery.data) {
      const next: Record<string, string> = {};
      for (const item of promptsQuery.data) next[item.role_name] = item.content;
      setDraft(next);
    }
  }, [promptsQuery.data]);

  const saveMutation = useMutation({
    mutationFn: (updates: Array<{ role_name: string; content: string }>) =>
      savePrompts(updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["prompts"] });
      setSavedAt(new Date().toLocaleTimeString("zh-CN"));
    },
  });

  const resetMutation = useMutation({
    mutationFn: () => resetPrompts(),
    onSuccess: (items) => {
      const next: Record<string, string> = {};
      for (const item of items) next[item.role_name] = item.content;
      setDraft(next);
      queryClient.setQueryData(["prompts"], items);
      setSavedAt(new Date().toLocaleTimeString("zh-CN"));
    },
  });

  const rows = promptsQuery.data ?? [];

  return (
    <div className="space-y-5">
      <header>
        <h2 className="text-2xl font-semibold tracking-tight">提示词</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          自定义智能选号角色的系统提示。保存后下一次推荐即生效。
        </p>
      </header>

      <section className="space-y-2 rounded-lg border border-border bg-card/40 p-4">
        <header>
          <h3 className="text-base font-semibold">运行时选号上下文</h3>
          <p className="text-xs text-muted-foreground">
            这部分随每次推荐动态生成，只读展示，不能手动保存。
          </p>
        </header>
        <pre className="whitespace-pre-wrap rounded-md border border-border bg-background px-3 py-2 text-sm leading-6 text-muted-foreground">
          {RUNTIME_PROMPT_PREVIEW}
        </pre>
      </section>

      {promptsQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">加载中…</p>
      ) : (
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            const updates = rows.map((item) => ({
              role_name: item.role_name,
              content: draft[item.role_name] ?? item.content,
            }));
            saveMutation.mutate(updates);
          }}
        >
          {rows.map((item) => (
            <PromptEditor
              key={item.role_name}
              record={item}
              value={draft[item.role_name] ?? ""}
              onChange={(next) =>
                setDraft((prev) => ({ ...prev, [item.role_name]: next }))
              }
            />
          ))}

          <div className="flex items-center justify-between">
            <div className="text-xs text-muted-foreground">
              {saveMutation.isPending || resetMutation.isPending
                ? "保存中…"
                : savedAt
                  ? `已于 ${savedAt} 保存`
                  : ""}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={resetMutation.isPending || saveMutation.isPending}
                onClick={() => resetMutation.mutate()}
                className={cn(
                  "inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm",
                  "hover:bg-accent hover:text-accent-foreground transition-colors",
                  resetMutation.isPending && "opacity-60 cursor-wait",
                )}
              >
                <RotateCcw className="h-4 w-4" aria-hidden />
                恢复默认
              </button>
              <button
                type="submit"
                disabled={saveMutation.isPending || resetMutation.isPending}
                className={cn(
                  "inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground",
                  "hover:bg-primary/90 transition-colors",
                  saveMutation.isPending && "opacity-60 cursor-wait",
                )}
              >
                <Save className="h-4 w-4" aria-hidden />
                保存
              </button>
            </div>
          </div>
          {resetMutation.isError && (
            <p className="text-sm text-destructive">
              恢复失败：{(resetMutation.error as Error).message}
            </p>
          )}
        </form>
      )}
    </div>
  );
}

function PromptEditor({
  record,
  value,
  onChange,
}: {
  record: PromptRecord;
  value: string;
  onChange: (next: string) => void;
}): JSX.Element {
  const meta = ROLE_META[record.role_name] ?? {
    label: record.role_name,
    hint: "",
  };
  return (
    <section className="space-y-2 rounded-lg border border-border p-4">
      <header className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold">{meta.label}</h3>
          {meta.hint && (
            <p className="text-xs text-muted-foreground">{meta.hint}</p>
          )}
        </div>
        <span className="text-xs text-muted-foreground">
          版本 {record.prompt_revision} · 摘要 {record.prompt_hash}
        </span>
      </header>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={6}
        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm font-mono"
      />
    </section>
  );
}
