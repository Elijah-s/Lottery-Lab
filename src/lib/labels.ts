export function strategyLabel(strategy: string | null | undefined): string {
  const labels: Record<string, string> = {
    balanced: "平衡",
    anti_popular: "反热门",
    recency_fade: "弱化近期",
  };
  return labels[strategy ?? ""] ?? "未知策略";
}

export function toneLabel(tone: string | null | undefined): string {
  const labels: Record<string, string> = {
    balanced: "平衡",
    conservative: "稳健",
    aggressive: "激进",
  };
  return labels[tone ?? ""] ?? "平衡";
}

export function strategyListLabel(strategies: readonly string[]): string {
  return strategies.map(strategyLabel).join("、");
}

export function sourceLabel(sourceName: string | null | undefined): string {
  const labels: Record<string, string> = {
    "17500-ssq-text": "备用开奖源（双色球）",
    "17500-dlt-text": "备用开奖源（大乐透）",
    "zhcw-official-api": "中彩网官方开奖源（双色球）",
    "cwl-official-api": "官方开奖源（双色球）",
    "sporttery-official-api": "官方开奖源（大乐透）",
  };
  return labels[sourceName ?? ""] ?? "未知来源";
}

export function providerLabel(provider: string | null | undefined): string {
  const labels: Record<string, string> = {
    openai: "OpenAI Compatible",
    anthropic: "Anthropic",
    deepseek: "DeepSeek",
    openrouter: "OpenRouter",
    lmstudio: "LM Studio",
    custom: "Custom",
  };
  return labels[provider ?? ""] ?? "Custom";
}
