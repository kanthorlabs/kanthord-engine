const ROOT = "/";

export function isUnder(path: string, dir: string): boolean {
  if (dir === ROOT) return path.startsWith(ROOT);
  return path.startsWith(dir + ROOT) || path === dir;
}
