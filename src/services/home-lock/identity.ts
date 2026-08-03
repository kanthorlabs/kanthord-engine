import type { HomeIdentity } from "./index.ts";

export function renderIdentity(identity: HomeIdentity): string {
  const literal = {
    version: identity.version,
    pid: identity.pid,
    host: identity.host,
    startedAt: identity.startedAt,
    instanceId: identity.instanceId,
  };
  return JSON.stringify(literal, null, 2) + "\n";
}

export function parseIdentity(bytes: string): HomeIdentity | null {
  try {
    const parsed = JSON.parse(bytes);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      parsed.version !== 1 ||
      !Number.isInteger(parsed.pid) ||
      typeof parsed.host !== "string" ||
      parsed.host === "" ||
      typeof parsed.startedAt !== "string" ||
      parsed.startedAt === "" ||
      typeof parsed.instanceId !== "string" ||
      parsed.instanceId === ""
    ) {
      return null;
    }
    return {
      version: 1,
      pid: parsed.pid,
      host: parsed.host,
      startedAt: parsed.startedAt,
      instanceId: parsed.instanceId,
    };
  } catch {
    return null;
  }
}
