import { HostError } from "@pluhub/sdk";

export function csvCell(value: unknown): string {
  let text = value == null ? "" : String(value);
  if (typeof value === "string" && /^[\s\u0000]*[=+\-@\t\r]/.test(text))
    text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
export function csvResponse(
  filename: string,
  columns: string[],
  rows: unknown[][],
) {
  if (rows.length > 10000)
    throw new HostError(
      "export_too_large",
      "记录超过 10000 条，请缩小筛选范围后导出",
      413,
    );
  return new Response(
    "\ufeff" +
      [columns, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") +
      "\r\n",
    {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    },
  );
}
export function exportGuard() {
  const last = new Map<string, number>();
  return (id: string) => {
    const now = Date.now();
    if (now - (last.get(id) ?? 0) < 5000)
      throw new HostError("export_rate_limited", "请稍后再导出", 429);
    for (const [key, at] of last) if (at < now - 60000) last.delete(key);
    last.set(id, now);
  };
}
