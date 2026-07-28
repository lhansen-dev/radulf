export function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const value = key(row);
    const group = grouped.get(value);
    if (group) group.push(row);
    else grouped.set(value, [row]);
  }
  return grouped;
}
