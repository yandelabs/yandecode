/**
 * Joins rows under a header, cutting at whole-row boundaries so the result stays within
 * `maxChars`, and says how many rows were dropped so the agent can narrow or widen the query.
 */
export function fitRows(header: string, rows: readonly string[], maxChars: number): string {
  const out: string[] = [header];
  let used = header.length;
  let kept = 0;
  for (const row of rows) {
    const reserve = kept < rows.length - 1 ? 80 : 0;
    if (used + 1 + row.length + reserve > maxChars && kept > 0) break;
    out.push(
      row.length > maxChars - used - 1
        ? `${row.slice(0, Math.max(0, maxChars - used - 20))} …[cut]`
        : row,
    );
    used += 1 + row.length;
    kept++;
  }
  const dropped = rows.length - kept;
  if (dropped > 0)
    out.push(`… ${dropped} more row(s) omitted (narrow the query or raise max_chars)`);
  return out.join('\n');
}
