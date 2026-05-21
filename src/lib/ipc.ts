/**
 * Typed wrappers around `@tauri-apps/api/core#invoke`.
 *
 * Keeping the command names centralized (and typed) means the UI calls
 * read like function calls instead of stringly-typed IPC. If a command
 * changes on the Rust side, adjust the type here and the TS compiler
 * tells us every caller that needs updating.
 */

import { invoke } from "@tauri-apps/api/core";

import type { LotteryType } from "@/domain/lotteryRules";

export interface SourceAttempt {
  source_name: string;
  source_url: string | null;
  status: string;
  fetched_count: number;
  valid_count: number;
  invalid_count: number;
  error: string | null;
}

export interface LotterySyncSummary {
  lottery_type: LotteryType;
  status: string;
  degraded: boolean;
  source_name: string | null;
  source_url: string | null;
  inserted_count: number;
  total_fetched: number;
  attempts: SourceAttempt[];
  error_summary: string | null;
}

export interface SyncSummary {
  ssq: LotterySyncSummary;
  dlt: LotterySyncSummary;
}

export interface DrawDto {
  id: number;
  lottery_type: LotteryType;
  issue: string;
  draw_date: string;
  numbers: {
    red?: number[];
    blue?: number[];
    front?: number[];
    back?: number[];
  };
  source_name: string | null;
  source_url: string | null;
  fetched_at: string;
}

export interface SyncRunDto {
  id: number;
  lottery_type: LotteryType;
  status: string;
  source_name: string | null;
  source_url: string | null;
  inserted_count: number;
  degraded: boolean;
  attempts: SourceAttempt[];
  error_summary: string | null;
  created_at: string;
}

export interface Analysis {
  source_mode: "llm" | "offline";
  model: string | null;
  markdown: string;
  sections: Record<string, unknown>;
  prompt_roles: string[];
  error: string | null;
}

export interface RecommendationOutput {
  id: number;
  lottery_type: LotteryType;
  target_issue: string;
  user_request: string;
  parsed_request: Record<string, unknown>;
  recommended_numbers: Record<string, unknown>;
  stake_amount: number;
  heuristic_score: number;
  rules_version: string;
  ticket_text: string;
  analysis: Analysis;
  candidate_snapshot: Record<string, unknown>;
  created_at: string;
}

export interface RecommendationDto extends Omit<RecommendationOutput, "analysis"> {
  analysis: Analysis;
}

export interface ReviewDto {
  id: number;
  recommendation_id: number;
  actual_draw: Record<string, number[]>;
  primary_hits: number;
  secondary_hits: number;
  notes: string | null;
  created_at: string;
}

export interface RecommendationInputPayload {
  lottery_type: LotteryType;
  target_issue: string;
  rules_version: string;
  user_request: string;
  parsed_request: Record<string, unknown>;
  ticket_text: string;
  stake_amount: number;
  heuristic_score: number;
  recommended_numbers: Record<string, unknown>;
  candidate_snapshot: Record<string, unknown>;
  history_summary: Record<string, unknown>;
  strategy: string;
  history_window_size: number;
  validated_history_count: number;
  latest_issue: string;
  candidate_pool?: LlmCandidatePayload[];
}

export interface LlmCandidatePayload {
  id: string;
  ticket: Record<string, unknown>;
  amount: number;
  formatted: string;
  score: number;
  breakdown: Record<string, unknown>;
  strategy: string;
}

export interface PromptRecord {
  role_name: string;
  content: string;
  prompt_revision: number;
  prompt_hash: string;
  updated_at: string;
}

export interface AiSettings {
  provider: string | null;
  base_url: string | null;
  model: string | null;
  has_api_key: boolean;
}

export interface AiSettingsInput {
  provider?: string;
  base_url?: string;
  model?: string;
  api_key?: string;
}

export interface LlmModelList {
  provider: string;
  base_url: string;
  models: string[];
}

export interface LlmConnectionTest {
  ok: boolean;
  provider: string;
  base_url: string;
  model: string;
  message: string;
}

export interface WorldCupMatchDto {
  id: number;
  fifa_match_id: string;
  match_no: number;
  stage: string;
  group_name: string | null;
  home_team: string;
  away_team: string;
  kickoff_utc: string;
  kickoff_beijing: string;
  venue: string;
  city: string;
  country: string;
  status: string;
  result: string | null;
  source_url: string;
  updated_at: string;
  intelligence_count: number;
  latest_prediction_id: number | null;
  latest_plan_id: number | null;
}

export interface WorldCupScheduleSync {
  inserted_or_updated: number;
  total_matches: number;
  source_name: string;
  source_url: string;
  status: string;
  message: string;
  fetched_at: string;
}

export interface SourceHealthDto {
  id: number;
  source_name: string;
  source_level: string;
  status: string;
  message: string | null;
  source_url: string | null;
  fetched_at: string;
  field_coverage: number;
  failure_rate: number;
  recommended_refresh_seconds: number;
}

export interface EvidenceItemDto {
  id: number;
  research_run_id: number;
  match_id: number;
  category: string;
  source_level: string;
  source_name: string;
  url: string;
  title: string;
  published_at: string | null;
  fetched_at: string;
  extracted_json: Record<string, unknown>;
  raw_hash: string;
  credibility: number;
  rule_check_json: Record<string, unknown>;
  accepted_by_rule: boolean;
  audit_status: string;
}

export interface ResearchRunDto {
  id: number;
  match_id: number;
  trigger_type: string;
  research_model_profile: Record<string, unknown>;
  search_plan_json: Record<string, unknown>;
  status: string;
  started_at: string;
  completed_at: string | null;
  evidence_bundle_hash: string;
  estimated_cost: number;
  actual_cost: number;
  evidence_count: number;
  accepted_count: number;
}

export interface PredictionRunDto {
  id: number;
  match_id: number;
  research_run_id: number | null;
  model_profile: Record<string, unknown>;
  prompt_revision: number;
  evidence_bundle_hash: string;
  local_probability: Record<string, number>;
  llm_probability: Record<string, number>;
  market_probability: Record<string, number>;
  final_probability: Record<string, number>;
  scoreline_distribution: Array<Record<string, unknown>>;
  confidence: number;
  disagreement_score: number;
  analysis_markdown: string;
  created_at: string;
}

export interface BudgetPlanDto {
  id: number;
  match_id: number;
  prediction_run_id: number | null;
  odds_snapshot_id: number | null;
  planning_mode: "official" | "reference_only" | "analysis_only" | string;
  budget: number;
  risk_mode: string;
  plan_json: Record<string, unknown>;
  expected_value: number;
  max_loss: number;
  status: string;
  created_at: string;
}

export interface WorldCupMatchDetailDto {
  match_info: WorldCupMatchDto;
  evidence: EvidenceItemDto[];
  predictions: PredictionRunDto[];
  budget_plans: BudgetPlanDto[];
  source_health: SourceHealthDto[];
}

export interface OddsSyncSummary {
  source_name: string;
  source_level: string;
  status: string;
  message: string;
  events_found: number;
  odds_found: number;
  fetched_at: string;
}

export interface QueueJobDto {
  id: number;
  job_type: string;
  status: string;
  payload_json: Record<string, unknown>;
  estimated_cost: number;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface BacktestRunDto {
  id: number;
  lottery_type: LotteryType;
  request_text: string;
  start_issue: string;
  end_issue: string;
  strategies: string[];
  summary: Record<string, unknown>;
  config_snapshot: Record<string, unknown>;
  report_markdown: string | null;
  created_at: string;
  sample_count: number;
}

export interface BacktestSampleDto {
  id: number;
  backtest_run_id: number;
  strategy_name: string;
  issue: string;
  generated_numbers: Record<string, unknown>;
  actual_numbers: Record<string, number[]>;
  score_snapshot: Record<string, unknown>;
  hit_summary: Record<string, number>;
}

export interface BacktestRunPayload {
  lottery_type: LotteryType;
  request_text: string;
  start_issue: string;
  end_issue: string;
  strategies: string[];
  summary: Record<string, unknown>;
  config_snapshot: Record<string, unknown>;
  report_markdown: string | null;
  samples: Array<{
    strategy_name: string;
    issue: string;
    generated_numbers: Record<string, unknown>;
    actual_numbers: Record<string, number[]>;
    score_snapshot: Record<string, unknown>;
    hit_summary: Record<string, number>;
  }>;
}

export interface BacktestExportPayload {
  filename: string;
  mime: string;
  bytes: number[];
}

export function syncDraws(limit?: number): Promise<SyncSummary> {
  return invoke<SyncSummary>("sync_draws", { limit });
}

export function listDraws(
  lotteryType: LotteryType,
  limit?: number,
): Promise<DrawDto[]> {
  return invoke<DrawDto[]>("list_draws", { lotteryType, limit });
}

export function listSyncRuns(limit?: number): Promise<SyncRunDto[]> {
  return invoke<SyncRunDto[]>("list_sync_runs", { limit });
}

export function createRecommendation(
  input: RecommendationInputPayload,
): Promise<RecommendationOutput> {
  return invoke<RecommendationOutput>("create_recommendation", { input });
}

export function listRecommendations(
  limit?: number,
): Promise<RecommendationDto[]> {
  return invoke<RecommendationDto[]>("list_recommendations", { limit });
}

export function deleteRecommendations(ids: number[]): Promise<number> {
  return invoke<number>("delete_recommendations", { ids });
}

export function reviewPending(): Promise<number> {
  return invoke<number>("review_pending");
}

export function listReviews(limit?: number): Promise<ReviewDto[]> {
  return invoke<ReviewDto[]>("list_reviews", { limit });
}

export function saveBacktest(input: BacktestRunPayload): Promise<number> {
  return invoke<number>("save_backtest", { input });
}

export function listBacktests(limit?: number): Promise<BacktestRunDto[]> {
  return invoke<BacktestRunDto[]>("list_backtests", { limit });
}

export function getBacktestSamples(runId: number): Promise<BacktestSampleDto[]> {
  return invoke<BacktestSampleDto[]>("get_backtest_samples", { runId });
}

export function exportBacktest(
  runId: number,
  format: "json" | "csv",
): Promise<BacktestExportPayload> {
  return invoke<BacktestExportPayload>("export_backtest", { runId, format });
}

export function getPrompts(): Promise<PromptRecord[]> {
  return invoke<PromptRecord[]>("get_prompts");
}

export function savePrompts(
  updates: Array<{ role_name: string; content: string }>,
): Promise<PromptRecord[]> {
  return invoke<PromptRecord[]>("save_prompts", { updates });
}

export function resetPrompts(): Promise<PromptRecord[]> {
  return invoke<PromptRecord[]>("reset_prompts");
}

export function getAiSettings(): Promise<AiSettings> {
  return invoke<AiSettings>("get_ai_settings");
}

export function saveAiSettings(input: AiSettingsInput): Promise<AiSettings> {
  return invoke<AiSettings>("save_ai_settings", { input });
}

export function listLlmModels(): Promise<LlmModelList> {
  return invoke<LlmModelList>("list_llm_models");
}

export function testLlmConnection(): Promise<LlmConnectionTest> {
  return invoke<LlmConnectionTest>("test_llm_connection");
}

export function syncWorldCupSchedule(): Promise<WorldCupScheduleSync> {
  return invoke<WorldCupScheduleSync>("sync_worldcup_schedule");
}

export function listWorldCupMatches(): Promise<WorldCupMatchDto[]> {
  return invoke<WorldCupMatchDto[]>("list_worldcup_matches");
}

export function getWorldCupMatchDetail(
  matchId: number,
): Promise<WorldCupMatchDetailDto> {
  return invoke<WorldCupMatchDetailDto>("get_worldcup_match_detail", {
    matchId,
  });
}

export function fetchPreMatchIntelligence(input: {
  match_id: number;
  query?: string;
  trigger_type?: string;
}): Promise<ResearchRunDto> {
  return invoke<ResearchRunDto>("fetch_pre_match_intelligence", { input });
}

export function listMatchEvidence(matchId: number): Promise<EvidenceItemDto[]> {
  return invoke<EvidenceItemDto[]>("list_match_evidence", { matchId });
}

export function runMatchPrediction(input: {
  match_id: number;
  research_run_id?: number | null;
}): Promise<PredictionRunDto> {
  return invoke<PredictionRunDto>("run_match_prediction", { input });
}

export function syncSportteryWorldCupOdds(): Promise<OddsSyncSummary> {
  return invoke<OddsSyncSummary>("sync_sporttery_worldcup_odds");
}

export function syncReferenceOddsSources(): Promise<OddsSyncSummary> {
  return invoke<OddsSyncSummary>("sync_reference_odds_sources");
}

export function createWorldCupBudgetPlan(input: {
  match_id: number;
  prediction_run_id?: number | null;
  budget?: number;
  risk_mode?: string;
}): Promise<BudgetPlanDto> {
  return invoke<BudgetPlanDto>("create_worldcup_budget_plan", { input });
}

export function listWorldCupSourceHealth(
  limit?: number,
): Promise<SourceHealthDto[]> {
  return invoke<SourceHealthDto[]>("list_worldcup_source_health", { limit });
}

export function listWorldCupQueueJobs(limit?: number): Promise<QueueJobDto[]> {
  return invoke<QueueJobDto[]>("list_worldcup_queue_jobs", { limit });
}

export function cancelWorldCupQueueJob(jobId: number): Promise<boolean> {
  return invoke<boolean>("cancel_worldcup_queue_job", { jobId });
}
