export type RowValue = string | number | null | undefined;
export type Row = readonly [name: string, value: RowValue];

const NAME_SUFFIX = ":";
const VALUE_GAP = 1;
const EMPTY_VALUE = "";

function present(rows: readonly Row[]): (readonly [string, string])[] {
  return rows.flatMap(([name, value]) =>
    value === null || value === undefined || value === EMPTY_VALUE
      ? []
      : [[name, String(value)] as const],
  );
}

export function rowWidth(names: readonly string[]): number {
  return Math.max(
    0,
    ...names.map((name) => name.length + NAME_SUFFIX.length + VALUE_GAP),
  );
}

export function formatRows(
  rows: readonly Row[],
  urls: readonly Row[] = [],
  width?: number,
): string {
  const values = present(rows);
  const column = width ?? rowWidth(values.map(([name]) => name));
  const lines = values.map(
    ([name, value]) => `${`${name}${NAME_SUFFIX}`.padEnd(column)}${value}`,
  );
  const links = present(urls).flatMap(([name, url]) => [
    `${name}${NAME_SUFFIX}`,
    url,
  ]);
  const blocks = [lines, links].filter((block) => block.length);
  return blocks.map((block) => `${block.join("\n")}\n`).join("\n");
}
