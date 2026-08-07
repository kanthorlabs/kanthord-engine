export type ByteRange = Readonly<{ start: number; end: number }>;

export function parseRange(
  header: string | undefined,
  size: number,
): ByteRange | null {
  if (header === undefined) return null;
  if (size === 0) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return null;

  const rawStart = match[1] ?? "";
  const rawEnd = match[2] ?? "";
  if (rawStart === "" && rawEnd === "") return null;

  if (rawStart === "") {
    const suffixLength = Number(rawEnd);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isSafeInteger(start) || start >= size) return null;

  if (rawEnd === "") {
    return { start, end: size - 1 };
  }

  const end = Number(rawEnd);
  if (!Number.isSafeInteger(end) || start > end) return null;

  return { start, end: Math.min(end, size - 1) };
}
