import { expect, test } from "bun:test";
import { expired } from "./retention";

const HOUR = 3600_000;
const now = Date.parse("2026-10-01T12:30:00Z");
const key = (at: number) => `pg/${new Date(at).toISOString()}.sql.zst`;

test("two years of hourly backups thin to 48 hours, then a day each for 30 days, then a month each for a year", () => {
  const keys = Array.from({ length: 2 * 365 * 24 }, (_, i) => key(now - i * HOUR - 5 * 60_000));
  const gone = new Set(expired(keys, now));
  const kept = keys.filter((k) => !gone.has(k));
  expect(kept.slice(0, 48)).toEqual(keys.slice(0, 48));
  // After those, the newest of each day back 30 days (September 1st to 28th; the 29th's is within 48 hours), then of each month back a year.
  const days = Array.from({ length: 28 }, (_, i) => key(Date.parse(`2026-09-${String(28 - i).padStart(2, "0")}T23:25:00Z`)));
  const months = ["2026-08-31", "2026-07-31", "2026-06-30", "2026-05-31", "2026-04-30", "2026-03-31", "2026-02-28", "2026-01-31", "2025-12-31", "2025-11-30", "2025-10-31"].map((d) => key(Date.parse(`${d}T23:25:00Z`)));
  expect(kept.slice(48)).toEqual([...days, ...months]);
  expect(kept).toContain(key(Date.parse("2026-09-15T23:25:00Z")));
  expect(kept).not.toContain(key(Date.parse("2026-09-15T22:25:00Z")));
  expect(kept).toContain(key(Date.parse("2026-03-31T23:25:00Z")));
  expect(kept).not.toContain(key(Date.parse("2026-03-30T23:25:00Z")));
});

test("keys that aren't timestamped backups are never deleted", () => {
  expect(expired(["pg/README", "pg/not-a-date.sql.zst"], now)).toEqual([]);
});
