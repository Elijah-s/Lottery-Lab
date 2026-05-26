/**
 * AI settings page — LLM provider / base URL / model / API key.
 *
 * The API key is a write-only field from the UI's perspective; we
 * never read it back (Rust returns `has_api_key` as a boolean). Users
 * can re-enter a key to update, or leave the field empty to keep the
 * current one.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BrainCircuit,
  CheckCircle2,
  ChevronDown,
  KeyRound,
  ListChecks,
  RefreshCw,
  Save,
  Search,
  WalletCards,
  Wifi,
} from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";

import {
  getAiSettings,
  listLlmModels,
  saveAiSettings,
  testLlmConnection,
  type AiSettings,
  type AiSettingsInput,
  type LlmProfileSettings,
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

type LlmFormState = {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
};

type WorldCupProfileKey = "worldcupResearch" | "worldcupPrediction" | "worldcupBudget";

type ProfileModelState = Record<WorldCupProfileKey, string[]>;
type ProfileMenuState = Record<WorldCupProfileKey, boolean>;
type ProfileConnectionState = Partial<Record<WorldCupProfileKey, LlmConnectionTest>>;

const DEFAULT_FORM: LlmFormState = {
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  apiKey: "",
};

const WORLD_CUP_PROFILE_META: Array<{
  key: WorldCupProfileKey;
  ipcProfile: "worldcup_research" | "worldcup_prediction" | "worldcup_budget";
  title: string;
  description: string;
  icon: LucideIcon;
}> = [
  {
    key: "worldcupResearch",
    ipcProfile: "worldcup_research",
    title: "赛前情报模型",
    description: "用于生成搜索计划和审查情报来源。",
    icon: Search,
  },
  {
    key: "worldcupPrediction",
    ipcProfile: "worldcup_prediction",
    title: "比赛模拟模型",
    description: "用于结合已审查情报输出胜平负分析。",
    icon: BrainCircuit,
  },
  {
    key: "worldcupBudget",
    ipcProfile: "worldcup_budget",
    title: "预算模拟模型",
    description: "用于把赔率状态和风险偏好整理成中文预算说明。",
    icon: WalletCards,
  },
];

export function SettingsPage(): JSX.Element {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: ["ai-settings"],
    queryFn: () => getAiSettings(),
  });
  const [form, setForm] = useState<LlmFormState>(DEFAULT_FORM);
  const [worldCupForms, setWorldCupForms] = useState<Record<WorldCupProfileKey, LlmFormState>>({
    worldcupResearch: DEFAULT_FORM,
    worldcupPrediction: DEFAULT_FORM,
    worldcupBudget: DEFAULT_FORM,
  });
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [profileModels, setProfileModels] = useState<ProfileModelState>({
    worldcupResearch: [],
    worldcupPrediction: [],
    worldcupBudget: [],
  });
  const [profileMenuOpen, setProfileMenuOpen] = useState<ProfileMenuState>({
    worldcupResearch: false,
    worldcupPrediction: false,
    worldcupBudget: false,
  });
  const [connectionResult, setConnectionResult] = useState<LlmConnectionTest | null>(null);
  const [profileConnectionResult, setProfileConnectionResult] =
    useState<ProfileConnectionState>({});

  useEffect(() => {
    if (settingsQuery.data) {
      setForm((prev) => ({
        ...prev,
        provider: settingsQuery.data.provider ?? prev.provider,
        baseUrl: settingsQuery.data.base_url ?? prev.baseUrl,
        model: settingsQuery.data.model ?? prev.model,
        apiKey: "",
      }));
      setWorldCupForms({
        worldcupResearch: profileToForm(settingsQuery.data.worldcup_research, formFromSettings(settingsQuery.data)),
        worldcupPrediction: profileToForm(settingsQuery.data.worldcup_prediction, formFromSettings(settingsQuery.data)),
        worldcupBudget: profileToForm(settingsQuery.data.worldcup_budget, formFromSettings(settingsQuery.data)),
      });
    }
  }, [settingsQuery.data]);

  const buildInput = (): AiSettingsInput => {
    const input: AiSettingsInput = {
      provider: form.provider.trim(),
      base_url: form.baseUrl.trim(),
      model: form.model.trim(),
      worldcup_research: profileInput(worldCupForms.worldcupResearch),
      worldcup_prediction: profileInput(worldCupForms.worldcupPrediction),
      worldcup_budget: profileInput(worldCupForms.worldcupBudget),
    };
    const key = form.apiKey.trim();
    if (key) input.api_key = key;
    return input;
  };

  const applySettings = (settings: AiSettings) => {
    queryClient.setQueryData<AiSettings>(["ai-settings"], settings);
    setSavedAt(new Date().toLocaleTimeString("zh-CN"));
    const globalForm = formFromSettings(settings);
    setForm((prev) => ({
      ...prev,
      provider: globalForm.provider,
      baseUrl: globalForm.baseUrl,
      model: globalForm.model,
      apiKey: "",
    }));
    setWorldCupForms({
      worldcupResearch: profileToForm(settings.worldcup_research, globalForm),
      worldcupPrediction: profileToForm(settings.worldcup_prediction, globalForm),
      worldcupBudget: profileToForm(settings.worldcup_budget, globalForm),
    });
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

  const profileModelsMutation = useMutation({
    mutationFn: async (profile: (typeof WORLD_CUP_PROFILE_META)[number]) => {
      const settings = await saveAiSettings(buildInput());
      const modelList = await listLlmModels(profile.ipcProfile);
      return { settings, modelList, profileKey: profile.key };
    },
    onSuccess: ({ settings, modelList, profileKey }) => {
      applySettings(settings);
      setProfileModels((prev) => ({ ...prev, [profileKey]: modelList.models }));
      setProfileMenuOpen((prev) => ({ ...prev, [profileKey]: modelList.models.length > 0 }));
      setProfileConnectionResult((prev) => ({ ...prev, [profileKey]: undefined }));
      if (!worldCupForms[profileKey].model.trim() && modelList.models.length > 0) {
        setWorldCupForms((prev) => ({
          ...prev,
          [profileKey]: { ...prev[profileKey], model: modelList.models[0] },
        }));
      }
    },
  });

  const profileConnectionMutation = useMutation({
    mutationFn: async (profile: (typeof WORLD_CUP_PROFILE_META)[number]) => {
      const settings = await saveAiSettings(buildInput());
      const result = await testLlmConnection(profile.ipcProfile);
      return { settings, result, profileKey: profile.key };
    },
    onSuccess: ({ settings, result, profileKey }) => {
      applySettings(settings);
      setProfileConnectionResult((prev) => ({ ...prev, [profileKey]: result }));
    },
  });

  const current: AiSettings | undefined = settingsQuery.data;
  const busy =
    saveMutation.isPending ||
    modelsMutation.isPending ||
    connectionMutation.isPending ||
    profileModelsMutation.isPending ||
    profileConnectionMutation.isPending;
  const actionError =
    saveMutation.error ??
    modelsMutation.error ??
    connectionMutation.error ??
    profileModelsMutation.error ??
    profileConnectionMutation.error;
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

        <section className="space-y-3 border-t border-border pt-4">
          <div>
            <h3 className="text-base font-semibold">世界杯智能模型</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              三个流程可以使用不同服务商、接口地址和模型；密钥留空时沿用上方通用密钥。
            </p>
          </div>
          <div className="grid gap-3 xl:grid-cols-3">
            {WORLD_CUP_PROFILE_META.map((profile) => (
              <WorldCupProfileCard
                key={profile.key}
                meta={profile}
                value={worldCupForms[profile.key]}
                saved={settingsQuery.data?.[profileToSettingsField(profile.key)]}
                models={profileModels[profile.key]}
                menuOpen={profileMenuOpen[profile.key]}
                connectionResult={profileConnectionResult[profile.key]}
                busy={busy}
                onChange={(next) =>
                  setWorldCupForms((prev) => ({
                    ...prev,
                    [profile.key]: next,
                  }))
                }
                onProviderChange={(provider) =>
                  setWorldCupForms((prev) => ({
                    ...prev,
                    [profile.key]: providerChangedState(provider, prev[profile.key]),
                  }))
                }
                onMenuOpenChange={(open) =>
                  setProfileMenuOpen((prev) => ({ ...prev, [profile.key]: open }))
                }
                onFetchModels={() => profileModelsMutation.mutate(profile)}
                onTestConnection={() => profileConnectionMutation.mutate(profile)}
              />
            ))}
          </div>
        </section>

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
  setForm((prev) => providerChangedState(value, prev));
}

function WorldCupProfileCard(props: {
  meta: (typeof WORLD_CUP_PROFILE_META)[number];
  value: LlmFormState;
  saved: LlmProfileSettings | undefined;
  models: string[];
  menuOpen: boolean;
  connectionResult: LlmConnectionTest | undefined;
  busy: boolean;
  onChange: (value: LlmFormState) => void;
  onProviderChange: (provider: string) => void;
  onMenuOpenChange: (open: boolean) => void;
  onFetchModels: () => void;
  onTestConnection: () => void;
}): JSX.Element {
  const Icon = props.meta.icon;
  return (
    <section className="rounded-md border border-border bg-background p-3">
      <div className="mb-3 flex items-start gap-2">
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0">
          <h4 className="font-medium leading-5">{props.meta.title}</h4>
          <p className="mt-0.5 text-xs text-muted-foreground">{props.meta.description}</p>
        </div>
      </div>
      <div className="space-y-3">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">服务商</span>
          <select
            value={props.value.provider}
            onChange={(event) => props.onProviderChange(event.target.value)}
            className={FIELD_CLASS}
          >
            {PROVIDER_PRESETS.map((preset) => (
              <option key={preset.value} value={preset.value}>
                {preset.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">接口地址</span>
          <input
            value={props.value.baseUrl}
            onChange={(event) => props.onChange({ ...props.value, baseUrl: event.target.value })}
            className={cn(FIELD_CLASS, "w-full")}
          />
        </label>
        <div className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">模型</span>
          <ModelPicker
            value={props.value.model}
            models={props.models}
            open={props.menuOpen}
            disabled={props.busy}
            placeholder="填写或获取模型"
            onChange={(model) => props.onChange({ ...props.value, model })}
            onOpenChange={props.onMenuOpenChange}
          />
        </div>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">接口密钥</span>
          <input
            type="password"
            value={props.value.apiKey}
            onChange={(event) => props.onChange({ ...props.value, apiKey: event.target.value })}
            placeholder={profileKeyPlaceholder(props.saved)}
            className={cn(FIELD_CLASS, "w-full")}
          />
        </label>
        {props.connectionResult ? (
          <p
            className={cn(
              "text-xs",
              props.connectionResult.ok ? "text-emerald-700" : "text-destructive",
            )}
          >
            {props.connectionResult.message}
          </p>
        ) : null}
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
          <button
            type="button"
            onClick={props.onFetchModels}
            disabled={props.busy || props.value.baseUrl.trim().length === 0}
            className="inline-flex items-center justify-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
          >
            <ListChecks className="h-4 w-4" aria-hidden />
            获取模型
          </button>
          <button
            type="button"
            onClick={props.onTestConnection}
            disabled={
              props.busy ||
              props.value.baseUrl.trim().length === 0 ||
              props.value.model.trim().length === 0
            }
            className="inline-flex items-center justify-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Wifi className="h-4 w-4" aria-hidden />
            测试
          </button>
        </div>
      </div>
    </section>
  );
}

function ModelPicker(props: {
  value: string;
  models: string[];
  open: boolean;
  disabled?: boolean;
  placeholder: string;
  onChange: (value: string) => void;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  return (
    <div className="relative min-w-0 flex-1">
      <input
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        onFocus={() => props.onOpenChange(props.models.length > 0)}
        onBlur={() => props.onOpenChange(false)}
        onKeyDown={(event) => {
          if (event.key === "Escape") props.onOpenChange(false);
        }}
        placeholder={props.placeholder}
        className={cn(FIELD_CLASS, "w-full pr-9")}
      />
      <button
        type="button"
        className="absolute inset-y-0 right-1 inline-flex w-8 items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-40"
        disabled={props.disabled || props.models.length === 0}
        onClick={() => props.onOpenChange(!props.open)}
        aria-label="展开模型列表"
      >
        <ChevronDown className="h-4 w-4" aria-hidden />
      </button>
      {props.open && props.models.length > 0 && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-56 overflow-auto rounded-md border border-border bg-card shadow-lg">
          {props.models.map((model) => (
            <button
              key={model}
              type="button"
              className={cn(
                "block w-full truncate px-3 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground",
                model === props.value && "bg-accent text-accent-foreground",
              )}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                props.onChange(model);
                props.onOpenChange(false);
              }}
              title={model}
            >
              {model}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function providerChangedState(value: string, prev: LlmFormState): LlmFormState {
  const nextPreset = PROVIDER_PRESETS.find((p) => p.value === value);
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
}

function formFromSettings(settings: AiSettings): LlmFormState {
  return {
    provider: settings.provider ?? DEFAULT_FORM.provider,
    baseUrl: settings.base_url ?? DEFAULT_FORM.baseUrl,
    model: settings.model ?? DEFAULT_FORM.model,
    apiKey: "",
  };
}

function profileToForm(profile: LlmProfileSettings, fallback: LlmFormState): LlmFormState {
  return {
    provider: profile.provider ?? fallback.provider,
    baseUrl: profile.base_url ?? fallback.baseUrl,
    model: profile.model ?? fallback.model,
    apiKey: "",
  };
}

function profileInput(form: LlmFormState) {
  const input = {
    provider: form.provider.trim(),
    base_url: form.baseUrl.trim(),
    model: form.model.trim(),
    api_key: undefined as string | undefined,
  };
  const key = form.apiKey.trim();
  if (key) input.api_key = key;
  return input;
}

function profileToSettingsField(
  key: WorldCupProfileKey,
): "worldcup_research" | "worldcup_prediction" | "worldcup_budget" {
  if (key === "worldcupResearch") return "worldcup_research";
  if (key === "worldcupPrediction") return "worldcup_prediction";
  return "worldcup_budget";
}

function profileKeyPlaceholder(profile: LlmProfileSettings | undefined): string {
  if (!profile?.has_api_key) return "未设置则沿用通用密钥";
  if (profile.api_key_source === "profile") return "已单独设置（留空不变）";
  if (profile.api_key_source === "global") return "正在沿用通用密钥";
  return "未设置则沿用通用密钥";
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
