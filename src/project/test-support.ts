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
  };
}
