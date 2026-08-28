const encoder = new TextEncoder();

export function compareBytewise(left: string, right: string): number {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const shared = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < shared; index += 1) {
    const difference =
      (leftBytes[index] as number) - (rightBytes[index] as number);
    if (difference !== 0) {
      return difference;
    }
  }
  return leftBytes.length - rightBytes.length;
}

export function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}
