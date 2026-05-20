/**
 * Ticket shapes + amount calculation + display formatting.
 *
 * Ticket shapes follow the three canonical modes (single / multiple /
 * danTuo) times the two lottery types (ssq / dlt). The math functions
 * here are pure and deterministic — no randomness, no IO.
 */

import { getRuleVersion, type LotteryType } from "@/domain/lotteryRules";

/** Shared across all ticket shapes so discriminated unions stay tidy. */
interface BaseTicket {
  lotteryType: LotteryType;
}

export interface SsqSingle extends BaseTicket {
  lotteryType: "ssq";
  mode: "single";
  reds: number[];
  blues: number[];
}

export interface SsqMultiple extends BaseTicket {
  lotteryType: "ssq";
  mode: "multiple";
  redBank: number[];
  blueBank: number[];
}

export interface SsqDanTuo extends BaseTicket {
  lotteryType: "ssq";
  mode: "danTuo";
  redDan: number[];
  redTuo: number[];
  blueBank: number[];
}

export interface DltSingle extends BaseTicket {
  lotteryType: "dlt";
  mode: "single";
  front: number[];
  back: number[];
  additional: boolean;
}

export interface DltMultiple extends BaseTicket {
  lotteryType: "dlt";
  mode: "multiple";
  frontBank: number[];
  backBank: number[];
  additional: boolean;
}

export interface DltDanTuo extends BaseTicket {
  lotteryType: "dlt";
  mode: "danTuo";
  frontDan: number[];
  frontTuo: number[];
  backDan: number[];
  backTuo: number[];
  additional: boolean;
}

export type SsqTicket = SsqSingle | SsqMultiple | SsqDanTuo;
export type DltTicket = DltSingle | DltMultiple | DltDanTuo;
export type Ticket = SsqTicket | DltTicket;

function comb(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  const kk = Math.min(k, n - k);
  let result = 1;
  for (let i = 0; i < kk; i += 1) {
    result = (result * (n - i)) / (i + 1);
  }
  return Math.round(result);
}

/**
 * Computes the cost of a ticket based on the lottery type's current rules.
 *
 * Uses C(n, k) to derive the number of single tickets the given
 * multiple/danTuo shape expands to, then multiplies by the unit price
 * (basePrice + extraPrice when additional).
 */
export function calculateAmount(ticket: Ticket): number {
  const rule = getRuleVersion(ticket.lotteryType);
  const unit =
    ticket.lotteryType === "dlt" && (ticket as DltTicket).additional
      ? rule.basePrice + rule.extraPrice
      : rule.basePrice;

  if (ticket.lotteryType === "ssq") {
    return unit * countSsqBets(ticket, rule.primaryPick);
  }
  return unit * countDltBets(ticket, rule.primaryPick, rule.secondaryPick);
}

function countSsqBets(ticket: SsqTicket, primaryPick: number): number {
  if (ticket.mode === "single") {
    return 1;
  }
  if (ticket.mode === "multiple") {
    return comb(ticket.redBank.length, primaryPick) * ticket.blueBank.length;
  }
  const need = primaryPick - ticket.redDan.length;
  if (need < 0) return 0;
  return comb(ticket.redTuo.length, need) * ticket.blueBank.length;
}

function countDltBets(
  ticket: DltTicket,
  primaryPick: number,
  secondaryPick: number,
): number {
  if (ticket.mode === "single") {
    return 1;
  }
  if (ticket.mode === "multiple") {
    return (
      comb(ticket.frontBank.length, primaryPick) *
      comb(ticket.backBank.length, secondaryPick)
    );
  }
  const frontNeed = primaryPick - ticket.frontDan.length;
  const backNeed = secondaryPick - ticket.backDan.length;
  if (frontNeed < 0 || backNeed < 0) return 0;
  return (
    comb(ticket.frontTuo.length, frontNeed) *
    comb(ticket.backTuo.length, backNeed)
  );
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

function renderNumbers(values: number[]): string {
  return [...values].sort((a, b) => a - b).map(pad).join(" ");
}

/**
 * Renders a human-readable ticket label. Stable, useful for display and
 * for deduplicating candidate tickets during recommendation generation.
 */
export function formatTicket(ticket: Ticket): string {
  if (ticket.lotteryType === "ssq") {
    return formatSsq(ticket);
  }
  return formatDlt(ticket);
}

function formatSsq(ticket: SsqTicket): string {
  if (ticket.mode === "single") {
    return `红 ${renderNumbers(ticket.reds)} + 蓝 ${renderNumbers(ticket.blues)}`;
  }
  if (ticket.mode === "multiple") {
    return `红（复）${renderNumbers(ticket.redBank)} + 蓝（复）${renderNumbers(ticket.blueBank)}`;
  }
  return `红胆 ${renderNumbers(ticket.redDan)} | 红拖 ${renderNumbers(ticket.redTuo)} + 蓝 ${renderNumbers(ticket.blueBank)}`;
}

function formatDlt(ticket: DltTicket): string {
  const additional = ticket.additional ? "（追加）" : "";
  if (ticket.mode === "single") {
    return `前 ${renderNumbers(ticket.front)} + 后 ${renderNumbers(ticket.back)}${additional}`;
  }
  if (ticket.mode === "multiple") {
    return `前（复）${renderNumbers(ticket.frontBank)} + 后（复）${renderNumbers(ticket.backBank)}${additional}`;
  }
  const frontLabel = ticket.frontDan.length
    ? `前胆 ${renderNumbers(ticket.frontDan)} | 前拖 ${renderNumbers(ticket.frontTuo)}`
    : `前 ${renderNumbers(ticket.frontTuo)}`;
  const backLabel = ticket.backDan.length
    ? `后胆 ${renderNumbers(ticket.backDan)} | 后拖 ${renderNumbers(ticket.backTuo)}`
    : `后 ${renderNumbers(ticket.backTuo)}`;
  return `${frontLabel} + ${backLabel}${additional}`;
}
