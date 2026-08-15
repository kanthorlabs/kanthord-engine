import { isLoopbackHost } from "./loopback.ts";

export const wildcardBinds = ["0.0.0.0", "::"] as const;

export const explicitAllowedHostsRequired =
  "http.allowedHosts requires an explicit non-empty list";

export function isWildcardBind(bind: string): boolean {
  return wildcardBinds.some((candidate) => candidate === bind);
}

export function deriveAllowedHosts(
  input: Readonly<{ bind: string; port: number }>,
): readonly string[] {
  if (isWildcardBind(input.bind)) {
    return [];
  }
  if (isLoopbackHost(input.bind)) {
    const entries = [`127.0.0.1:${input.port}`, `localhost:${input.port}`];
    if (input.bind === "::1") {
      entries.push(`[::1]:${input.port}`);
    }
    return entries;
  }
  const authority = input.bind.includes(":") ? `[${input.bind}]` : input.bind;
  return [`${authority}:${input.port}`];
}
