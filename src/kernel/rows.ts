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

export function formatRows(
  rows: readonly Row[],
  urls: readonly Row[] = [],
): string {
  const values = present(rows);
  const width = Math.max(
    0,
    ...values.map(([name]) => name.length + NAME_SUFFIX.length + VALUE_GAP),
  );
  const lines = values.map(
    ([name, value]) => `${`${name}${NAME_SUFFIX}`.padEnd(width)}${value}`,
  );
  const links = present(urls).flatMap(([name, url]) => [
    `${name}${NAME_SUFFIX}`,
    url,
  ]);
  const blocks = [lines, links].filter((block) => block.length);
  return blocks.map((block) => `${block.join("\n")}\n`).join("\n");
}
