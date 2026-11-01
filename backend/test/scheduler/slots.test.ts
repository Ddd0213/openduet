// Slot math (L75): local schedule -> UTC instants, DST, weekdays-only, checkinMinute.
import { describe, expect, test } from "bun:test";
import { checkinTimes, localParts, nextSlot, parseBriefTime, safeZone, slotsBetween, specFor, zonedInstant } from "../../src/scheduler/slots.ts";

const iso = (d: Date) => d.toISOString();
const at = (s: string) => new Date(s);
const user = (over: Partial<{ timezone: string; briefTime: string; checkinMinute: number; weekendsOn: boolean }> = {}) =>
  ({ timezone: "UTC", briefTime: "08:19", checkinMinute: 49, weekendsOn: false, ...over });

describe("zonedInstant", () => {
  test("plain zones", () => {
    expect(iso(zonedInstant({ year: 2030, month: 10, day: 25 }, { hour: 8, minute: 19 }, "Asia/Shanghai"))).toBe("2030-10-25T00:19:00.000Z");
    expect(iso(zonedInstant({ year: 2030, month: 10, day: 25 }, { hour: 8, minute: 19 }, "UTC"))).toBe("2030-10-25T08:19:00.000Z");
    expect(iso(zonedInstant({ year: 2030, month: 3, day: 8 }, { hour: 8, minute: 19 }, "America/New_York"))).toBe("2030-03-08T13:19:00.000Z");
    expect(iso(zonedInstant({ year: 2030, month: 3, day: 11 }, { hour: 8, minute: 19 }, "America/New_York"))).toBe("2030-03-11T12:19:00.000Z");
  });

  test("a local time that doesn't exist (spring forward) moves forward by the gap", () => {
    // New York 2030-03-10: 02:00 EST -> 03:00 EDT
    expect(iso(zonedInstant({ year: 2030, month: 3, day: 10 }, { hour: 2, minute: 30 }, "America/New_York"))).toBe("2030-03-10T07:30:00.000Z");
    expect(localParts(at("2030-03-10T07:30:00.000Z"), "America/New_York")).toMatchObject({ hour: 3, minute: 30 });
    // London 2030-03-31: 01:00 GMT -> 02:00 BST
    expect(iso(zonedInstant({ year: 2030, month: 3, day: 31 }, { hour: 1, minute: 30 }, "Europe/London"))).toBe("2030-03-31T01:30:00.000Z");
  });

  test("a local time that happens twice (fall back) takes the first occurrence", () => {
    // New York 2030-11-03: 01:30 EDT (05:30Z) and again 01:30 EST (06:30Z)
    expect(iso(zonedInstant({ year: 2030, month: 11, day: 3 }, { hour: 1, minute: 30 }, "America/New_York"))).toBe("2030-11-03T05:30:00.000Z");
    // London 2030-10-27: 01:30 BST (00:30Z) and 01:30 GMT (01:30Z)
    expect(iso(zonedInstant({ year: 2030, month: 10, day: 27 }, { hour: 1, minute: 30 }, "Europe/London"))).toBe("2030-10-27T00:30:00.000Z");
  });
});

describe("schedules", () => {
  test("briefTime and checkinMinute parse; bad values fall back to the defaults", () => {
    expect(parseBriefTime("07:03")).toEqual({ hour: 7, minute: 3 });
    expect(parseBriefTime("25:00")).toEqual({ hour: 8, minute: 19 });
    expect(parseBriefTime("nope")).toEqual({ hour: 8, minute: 19 });
    expect(checkinTimes(7)).toEqual([10, 13, 16, 19, 22].map((hour) => ({ hour, minute: 7 })));
    expect(checkinTimes(99).map((t) => t.minute)).toEqual([49, 49, 49, 49, 49]);
    expect(safeZone("Not/AZone")).toBe("UTC");
    expect(specFor(user({ timezone: "Not/AZone" }), "brief").timeZone).toBe("UTC");
  });

  test("5 check-ins a weekday at the user's minute; start exclusive, end inclusive", () => {
    const spec = specFor(user({ checkinMinute: 7 }), "checkin");
    const day = slotsBetween(spec, at("2030-10-25T00:00:00Z"), at("2030-10-26T00:00:00Z"));
    expect(day.map(iso)).toEqual(["10:07", "13:07", "16:07", "19:07", "22:07"].map((t) => `2030-10-25T${t}:00.000Z`));
    expect(slotsBetween(spec, at("2030-10-25T10:07:00Z"), at("2030-10-25T13:07:00Z")).map(iso)).toEqual(["2030-10-25T13:07:00.000Z"]);
  });

  test("weekdays only until weekends are on", () => {
    const off = specFor(user(), "checkin");
    const on = specFor(user({ weekendsOn: true }), "checkin");
    // Friday 2030-10-25 22:50 UTC, after the last check-in
    expect(iso(nextSlot(off, at("2030-10-25T22:50:00Z")))).toBe("2030-10-28T10:49:00.000Z");
    expect(iso(nextSlot(on, at("2030-10-25T22:50:00Z")))).toBe("2030-10-26T10:49:00.000Z");
    expect(slotsBetween(off, at("2030-10-26T00:00:00Z"), at("2030-10-28T00:00:00Z"))).toEqual([]);
    expect(slotsBetween(on, at("2030-10-26T00:00:00Z"), at("2030-10-28T00:00:00Z"))).toHaveLength(10);
  });

  test("the weekday is the user's local one, not UTC's", () => {
    // Auckland (NZDT, +13): Monday 2030-10-28 08:19 local is Sunday 19:19 UTC.
    const spec = specFor(user({ timezone: "Pacific/Auckland" }), "brief");
    expect(slotsBetween(spec, at("2030-10-26T00:00:00Z"), at("2030-10-28T00:00:00Z")).map(iso)).toEqual(["2030-10-27T19:19:00.000Z"]);
    expect(iso(nextSlot(spec, at("2030-10-25T20:00:00Z")))).toBe("2030-10-27T19:19:00.000Z");
  });

  test("the brief stays at local 08:19 across a DST change", () => {
    const spec = specFor(user({ timezone: "America/New_York", weekendsOn: true }), "brief");
    expect(slotsBetween(spec, at("2030-03-09T00:00:00Z"), at("2030-03-11T00:00:00Z")).map(iso)).toEqual([
      "2030-03-09T13:19:00.000Z", // Saturday, EST
      "2030-03-10T12:19:00.000Z", // Sunday, EDT
    ]);
    expect(iso(nextSlot(spec, at("2030-11-02T12:19:00Z")))).toBe("2030-11-03T13:19:00.000Z");
  });
});
