/** Which backups to delete: every one from the last 48 hours, then the newest of each day for 30 days and of each month for 12 months. Keys end in an ISO timestamp. */
export function expired(keys: string[], now: number) {
  const HOUR = 3600_000;
  const stamped = keys.map((key) => ({ key, at: Date.parse(key.match(/(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/)?.[1] ?? "") })).filter((b) => !Number.isNaN(b.at));
  const keep = new Set<string>();
  const newest = new Map<string, string>();
  for (const b of stamped.sort((a, b) => b.at - a.at)) {
    const age = now - b.at;
    if (age < 48 * HOUR) keep.add(b.key);
    const day = new Date(b.at).toISOString().slice(0, 10);
    const month = day.slice(0, 7);
    if (age < 30 * 24 * HOUR && !newest.has(day)) newest.set(day, b.key);
    if (age < 365 * 24 * HOUR && !newest.has(month)) newest.set(month, b.key);
  }
  for (const key of newest.values()) keep.add(key);
  return stamped.filter((b) => !keep.has(b.key)).map((b) => b.key);
}
