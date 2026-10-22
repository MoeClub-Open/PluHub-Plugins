// Calendar renewal clamped to the target month's last day (Jan 31 -> Feb 28/29).
export function nextPeriod(at: number, interval: "month" | "year"): number {
  const date = new Date(at);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  if (interval === "year") date.setUTCFullYear(date.getUTCFullYear() + 1);
  else date.setUTCMonth(date.getUTCMonth() + 1);
  const last = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
  ).getUTCDate();
  date.setUTCDate(Math.min(day, last));
  return date.getTime();
}
