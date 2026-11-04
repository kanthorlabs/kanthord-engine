import type { EnvironmentAgent } from "./environment-agent.ts";
import type { EnvironmentProbeRunner } from "./environment-probe-contract.ts";
import type { EnvironmentRuntime } from "./environment-state.ts";

export function inertEnvironmentRuntime(): EnvironmentRuntime {
  return {
    runtimeName: "podman",
    imageId: async () => null,
    pullImage: async () => {},
    imageExists: async () => false,
    build: async () => ({ outcome: "built" }),
    prove: async () => [],
    proveOnHost: async () => [],
    tagProved: async () => {},
    removeTags: async () => {},
    collect: async () => {},
    removeStaleRuns: async () => {},
    cacheVolumes: async () => [],
    removeCacheVolume: async () => {},
    footprintUsage: async () => ({
      usage: { runtime: "podman", images: [], volumes: [] },
      owned_image_ids: [],
      cache_volumes: [],
    }),
    removeImage: async () => false,
  };
}

export function inertEnvironmentAgent(): Pick<
  EnvironmentAgent,
  "enabled" | "run"
> {
  return { enabled: () => false, run: async () => "not_enabled" };
}

export function inertEnvironmentProbe(): EnvironmentProbeRunner {
  return { run: async () => ({ image: null, exit_code: null, output: "" }) };
}
