import {
  IST_TIME_ZONE,
  istNow,
  istTodayKey,
  parseClockTime,
  parseDateKey,
  parseWallClock,
  parseWallClockAt,
} from "../istTime";

describe("IST today", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test("just before IST midnight is still the same IST day (23:59 on 17 Oct)", () => {
    // 18:29Z is 23:59 IST: a device on UTC would still call this the 17th,
    // but a device behind UTC could already be on the 16th.
    jest.useFakeTimers().setSystemTime(new Date("2026-10-17T18:29:00Z"));
    expect(IST_TIME_ZONE).toBe("Asia/Kolkata");
    expect(istTodayKey()).toBe("2026-10-17");
    expect(istNow().getDate()).toBe(17);
    expect(istNow().getHours()).toBe(23);
    expect(istNow().getMinutes()).toBe(59);
  });

  test("just after IST midnight is already the next IST day (00:01 on 18 Oct)", () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-10-17T18:31:00Z"));
    expect(istTodayKey()).toBe("2026-10-18");
    expect(istNow().getDate()).toBe(18);
    expect(istNow().getHours()).toBe(0);
  });
});

describe("date-only parsing", () => {
  test("a date key never shifts the day", () => {
    const d = parseDateKey("2026-10-17");
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(9);
    expect(d.getDate()).toBe(17);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
  });

  test("a timestamp's date part is read as IST wall clock, not UTC midnight", () => {
    const d = parseWallClock("2026-10-17T00:00:00");
    expect(d.getDate()).toBe(17);
    expect(d.getHours()).toBe(0);
  });

  test("a zoned timestamp is shifted into IST", () => {
    // 09:00Z is 14:30 IST.
    const d = parseWallClock("2026-10-17T09:00:00Z");
    expect(d.getDate()).toBe(17);
    expect(d.getHours()).toBe(14);
    expect(d.getMinutes()).toBe(30);
  });
});

describe("wall-clock times", () => {
  test("a start and end keep their own clock times", () => {
    const start = parseWallClockAt("2026-10-17", "09:15");
    const end = parseWallClockAt("2026-10-17", "10:45");
    expect(start.getHours()).toBe(9);
    expect(start.getMinutes()).toBe(15);
    expect(end.getHours()).toBe(10);
    expect(end.getMinutes()).toBe(45);
  });

  test("a missing or malformed time is null, never midnight", () => {
    expect(parseWallClockAt("2026-10-17", null)).toBeNull();
    expect(parseWallClockAt("2026-10-17", "")).toBeNull();
    expect(parseWallClockAt("2026-10-17", "not a time")).toBeNull();
    expect(parseClockTime("2026-10-17T09:00:00")).toBeNull();
  });
});
