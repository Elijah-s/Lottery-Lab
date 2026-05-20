import { describe, expect, it } from "vitest";
import {
  calculateAmount,
  formatTicket,
  type DltDanTuo,
  type DltMultiple,
  type DltSingle,
  type SsqDanTuo,
  type SsqMultiple,
  type SsqSingle,
} from "@/domain/ticketMath";

describe("calculateAmount (SSQ)", () => {
  it("prices a single ticket at 2 yuan", () => {
    const ticket: SsqSingle = {
      lotteryType: "ssq",
      mode: "single",
      reds: [1, 5, 9, 12, 20, 27],
      blues: [3],
    };
    expect(calculateAmount(ticket)).toBe(2);
  });

  it("prices multiple: 7 reds + 2 blues = C(7,6) * 2 * 2 = 28", () => {
    const ticket: SsqMultiple = {
      lotteryType: "ssq",
      mode: "multiple",
      redBank: [1, 2, 3, 4, 5, 6, 7],
      blueBank: [1, 2],
    };
    expect(calculateAmount(ticket)).toBe(28);
  });

  it("prices danTuo: 2 dan + 5 tuo (need 4) + 1 blue = C(5,4)*1*2 = 10", () => {
    const ticket: SsqDanTuo = {
      lotteryType: "ssq",
      mode: "danTuo",
      redDan: [1, 2],
      redTuo: [3, 4, 5, 6, 7],
      blueBank: [9],
    };
    expect(calculateAmount(ticket)).toBe(10);
  });
});

describe("calculateAmount (DLT)", () => {
  it("prices basic single at 2 yuan", () => {
    const ticket: DltSingle = {
      lotteryType: "dlt",
      mode: "single",
      front: [1, 2, 3, 4, 5],
      back: [1, 2],
      additional: false,
    };
    expect(calculateAmount(ticket)).toBe(2);
  });

  it("prices single with additional at 3 yuan", () => {
    const ticket: DltSingle = {
      lotteryType: "dlt",
      mode: "single",
      front: [1, 2, 3, 4, 5],
      back: [1, 2],
      additional: true,
    };
    expect(calculateAmount(ticket)).toBe(3);
  });

  it("prices multiple: 6 front + 3 back = C(6,5) * C(3,2) * 2 = 36", () => {
    const ticket: DltMultiple = {
      lotteryType: "dlt",
      mode: "multiple",
      frontBank: [1, 2, 3, 4, 5, 6],
      backBank: [1, 2, 3],
      additional: false,
    };
    expect(calculateAmount(ticket)).toBe(36);
  });

  it("prices danTuo: 1 front dan + 5 front tuo (need 4), 0 back dan + 3 back tuo (need 2), no additional = C(5,4)*C(3,2)*2 = 30", () => {
    const ticket: DltDanTuo = {
      lotteryType: "dlt",
      mode: "danTuo",
      frontDan: [1],
      frontTuo: [2, 3, 4, 5, 6],
      backDan: [],
      backTuo: [1, 2, 3],
      additional: false,
    };
    expect(calculateAmount(ticket)).toBe(30);
  });
});

describe("formatTicket", () => {
  it("sorts and zero-pads SSQ single numbers", () => {
    const ticket: SsqSingle = {
      lotteryType: "ssq",
      mode: "single",
      reds: [27, 1, 12, 9, 5, 20],
      blues: [3],
    };
    expect(formatTicket(ticket)).toBe("红 01 05 09 12 20 27 + 蓝 03");
  });

  it("marks DLT additional tickets", () => {
    const ticket: DltSingle = {
      lotteryType: "dlt",
      mode: "single",
      front: [1, 2, 3, 4, 5],
      back: [11, 4],
      additional: true,
    };
    expect(formatTicket(ticket)).toContain("（追加）");
    expect(formatTicket(ticket)).toMatch(/后 04 11/);
  });
});
