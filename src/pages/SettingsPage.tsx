/**
 * AI settings page — LLM provider / base URL / model / API key.
 *
 * The API key is a write-only field from the UI's perspective; we
 * never read it back (Rust returns `has_api_key` as a boolean). Users
 * can re-enter a key to update, or leave the field empty to keep the
 * current one.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ChevronDown, KeyRound, ListChecks, RefreshCw, Save, Wifi } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import { useEffect, useState } from "react";

import {
  getAiSettings,
  listLlmModels,
  saveAiSettings,
  testLlmConnection,
  type AiSettings,
  type AiSettingsInput,
  type LlmConnectionTest,
} from "@/lib/ipc";
import { cn } from "@/lib/utils";

const PROVIDER_PRESETS: { value: string; label: string; baseUrl: string; model: string }[] = [
  { value: "openai", label: "OpenAI Compatible", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { value: "anthropic", label: "Anthropic", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-4-20250514" },
  { value: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { value: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "anthropic/claude-3.5-sonnet" },
  { value: "lmstudio", label: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1", model: "local-model" },
  { value: "custom", label: "Custom", baseUrl: "", model: "" },
];

const FIELD_CLASS = "rounded-md border border-border bg-background px-2 py-1.5";

export function SettingsPage(): JSX.Element {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: ["ai-settings"],
    queryFn: () => getAiSettings(),
  });
  const [form, setForm] = useState({
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    apiKey: "",
  });
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [connectionResult, setConnectionResult] = useState<LlmConnectionTest | null>(null);

  useEffect(() => {
    if (settingsQuery.data) {
      setForm((prev) => ({
        ...prev,
        provider: settingsQuery.data.provider ?? prev.provider,
        baseUrl: settingsQuery.data.base_url ?? prev.baseUrl,
        model: settingsQuery.data.model ?? prev.model,
        apiKey: "",
      }));
    }
  }, [settingsQuery.data]);

  const buildInput = (): AiSettingsInput => {
    const input: AiSettingsInput = {
      provider: form.provider.trim(),
      base_url: form.baseUrl.trim(),
      model: form.model.trim(),
    };
    const key = form.apiKey.trim();
    if (key) input.api_key = key;
    return input;
  };

  const applySettings = (settings: AiSettings) => {
    queryClient.setQueryData<AiSettings>(["ai-settings"], settings);
    setSavedAt(new Date().toLocaleTimeString("zh-CN"));
    setForm((prev) => ({
      ...prev,
      provider: settings.provider ?? prev.provider,
      baseUrl: settings.base_url ?? prev.baseUrl,
      model: settings.model ?? prev.model,
      apiKey: "",
    }));
  };

  const saveMutation = useMutation({
    mutationFn: (input: AiSettingsInput) => saveAiSettings(input),
    onSuccess: (settings) => {
      applySettings(settings);
      setConnectionResult(null);
    },
  });

  const modelsMutation = useMutation({
    mutationFn: async () => {
      const settings = await saveAiSettings(buildInput());
      const modelList = await listLlmModels();
      return { settings, modelList };
    },
    onSuccess: ({ settings, modelList }) => {
      applySettings(settings);
      setAvailableModels(modelList.models);
      setModelMenuOpen(modelList.models.length > 0);
      setConnectionResult(null);
      if (!form.model.trim() && modelList.models.length > 0) {
        setForm((prev) => ({ ...prev, model: modelList.models[0] }));
      }
    },
  });

  const connectionMutation = useMutation({
    mutationFn: async () => {
      const settings = await saveAiSettings(buildInput());
      const result = await testLlmConnection();
      return { settings, result };
    },
    onSuccess: ({ settings, result }) => {
      applySettings(settings);
      setConnectionResult(result);
    },
  });

  const current: AiSettings | undefined = settingsQuery.data;
  const busy = saveMutation.isPending || modelsMutation.isPending || connectionMutation.isPending;
  const actionError = saveMutation.error ?? modelsMutation.error ?? connectionMutation.error;
  const statusText = getStatusText({
    current,
    savedAt,
    savePending: saveMutation.isPending,
    modelsPending: modelsMutation.isPending,
    connectionPending: connectionMutation.isPending,
  });

  return (
    <div className="space-y-5">
      <header>
        <h2 className="text-2xl font-semibold tracking-tight">设置</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          切换模型服务、接口地址和模型，或更新接口密钥。密钥本地存储，不通过前端回显。
        </p>
      </header>

      <form
        className="space-y-4 rounded-lg border border-border bg-card/70 p-5"
        onSubmit={(event) => {
          event.preventDefault();
          saveMutation.mutate(buildInput());
        }}
      >
        <div className="grid gap-4 md:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">模型服务</span>
            <select
              value={form.provider}
              onChange={(event) => handleProviderChange(event.target.value, setForm)}
              className={FIELD_CLASS}
            >
              {PROVIDER_PRESETS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">接口地址</span>
            <input
              value={form.baseUrl}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, baseUrl: event.target.value }))
              }
              className={FIELD_CLASS}
            />
          </label>
          <div className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">模型</span>
            <div className="flex gap-2">
              <div className="relative min-w-0 flex-1">
                <input
                  value={form.model}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, model: event.target.value }))
                  }
                  onFocus={() => setModelMenuOpen(availableModels.length > 0)}
                  onBlur={() => setModelMenuOpen(false)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setModelMenuOpen(false);
                  }}
                  placeholder="gpt-4o-mini"
                  className={cn(FIELD_CLASS, "w-full pr-9")}
                />
                <button
                  type="button"
                  className="absolute inset-y-0 right-1 inline-flex w-8 items-center justify-center text-muted-foreground hover:text-foreground"
                  disabled={availableModels.length === 0}
                  onClick={() => setModelMenuOpen((open) => !open)}
                  aria-label="展开模型列表"
                >
                  <ChevronDown className="h-4 w-4" aria-hidden />
                </button>
                {modelMenuOpen && availableModels.length > 0 && (
                  <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-56 overflow-auto rounded-md border border-border bg-card shadow-lg">
                    {availableModels.map((model) => (
                      <button
                        key={model}
                        type="button"
                        className={cn(
                          "block w-full truncate px-3 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground",
                          model === form.model && "bg-accent text-accent-foreground",
                        )}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => {
                          setForm((prev) => ({ ...prev, model }));
                          setModelMenuOpen(false);
                        }}
                        title={model}
                      >
                        {model}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => modelsMutation.mutate()}
                disabled={busy || form.baseUrl.trim().length === 0}
                className={cn(
                  "inline-flex shrink-0 items-center gap-2 rounded-md border border-border px-3 py-1.5",
                  "hover:bg-accent hover:text-accent-foreground transition-colors",
                  "disabled:opacity-60 disabled:cursor-not-allowed",
                )}
              >
                <ListChecks className="h-4 w-4" aria-hidden />
                获取模型
              </button>
            </div>
            {availableModels.length > 0 && (
              <span className="text-xs text-muted-foreground">
                已获取 {availableModels.length} 个模型
              </span>
            )}
          </div>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground flex items-center gap-1">
              <KeyRound className="h-3 w-3" aria-hidden /> 接口密钥
            </span>
            <input
              type="password"
              value={form.apiKey}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, apiKey: event.target.value }))
              }
              placeholder={
                current?.has_api_key
                  ? "已设置（留空不变）"
                  : "尚未设置，填入以启用智能解释"
              }
              className={FIELD_CLASS}
            />
          </label>
        </div>

        {connectionResult && (
          <p
            className={cn(
              "flex items-center gap-1 text-xs",
              connectionResult.ok ? "text-emerald-700" : "text-destructive",
            )}
          >
            {connectionResult.ok && <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />}
            {connectionResult.message}
          </p>
        )}

        {actionError && (
          <p className="text-sm text-destructive">
            操作失败：{errorMessage(actionError)}
          </p>
        )}

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-xs text-muted-foreground">{statusText}</div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => connectionMutation.mutate()}
              disabled={busy || form.baseUrl.trim().length === 0 || form.model.trim().length === 0}
              className={cn(
                "inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm",
                "hover:bg-accent hover:text-accent-foreground transition-colors",
                "disabled:opacity-60 disabled:cursor-not-allowed",
              )}
            >
              {connectionMutation.isPending ? (
                <RefreshCw className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Wifi className="h-4 w-4" aria-hidden />
              )}
              测试连接
            </button>
            <button
              type="submit"
              disabled={busy}
              className={cn(
                "inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground",
                "hover:bg-primary/90 transition-colors",
                busy && "opacity-60 cursor-wait",
              )}
            >
              <Save className="h-4 w-4" aria-hidden />
              保存
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

function handleProviderChange(
  value: string,
  setForm: Dispatch<SetStateAction<{
    provider: string;
    baseUrl: string;
    model: string;
    apiKey: string;
  }>>,
) {
  const nextPreset = PROVIDER_PRESETS.find((p) => p.value === value);
  setForm((prev) => {
    const previousPreset = PROVIDER_PRESETS.find((p) => p.value === prev.provider);
    const baseWasCustomized =
      prev.baseUrl.trim().length > 0 &&
      (!previousPreset || prev.baseUrl !== previousPreset.baseUrl);
    const modelWasCustomized =
      prev.model.trim().length > 0 &&
      (!previousPreset || prev.model !== previousPreset.model);
    return {
      ...prev,
      provider: value,
      baseUrl: baseWasCustomized ? prev.baseUrl : nextPreset?.baseUrl ?? prev.baseUrl,
      model: modelWasCustomized ? prev.model : nextPreset?.model ?? prev.model,
    };
  });
}

function getStatusText(input: {
  current: AiSettings | undefined;
  savedAt: string | null;
  savePending: boolean;
  modelsPending: boolean;
  connectionPending: boolean;
}): string {
  if (input.savePending) return "保存中...";
  if (input.modelsPending) return "保存并获取模型中...";
  if (input.connectionPending) return "保存并测试连接中...";
  if (input.savedAt) return `已于 ${input.savedAt} 保存`;
  if (input.current?.has_api_key) return "接口密钥已配置";
  return "接口密钥未配置，推荐将使用离线摘要。";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
