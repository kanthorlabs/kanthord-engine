export const ROOT_BASE_PATH = "/";
export const BASE_PATH_FORMAT = /^(\/[A-Za-z0-9._~-]+)+$/;

export function stripBasePath(
  basePath: string,
  path: string,
): string | undefined {
  if (basePath === ROOT_BASE_PATH) return path;
  return path.startsWith(`${basePath}/`)
    ? path.slice(basePath.length)
    : undefined;
}

export function baseHref(basePath: string): string {
  return basePath === ROOT_BASE_PATH ? ROOT_BASE_PATH : `${basePath}/`;
}
