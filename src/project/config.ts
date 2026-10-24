import convict, { type Schema } from "convict";
import { isNumber } from "../kernel/values.ts";

export interface ProjectConfig {
  environment_build_timeout_ms: number;
  environment_memory_mb: number;
}

export const DEFAULT_ENVIRONMENT_BUILD_TIMEOUT_MS = 1800000;
export const DEFAULT_ENVIRONMENT_MEMORY_MB = 4096;
const ENVIRONMENT_BUILD_TIMEOUT_MS_MIN = 60000;
const ENVIRONMENT_MEMORY_MB_MIN = 256;
const ENVIRONMENT_BUILD_TIMEOUT_MS_FORMAT =
  "project-environment-build-timeout-ms";
const ENVIRONMENT_MEMORY_MB_FORMAT = "project-environment-memory-mb";

function addMinimumFormat(name: string, minimum: number): void {
  convict.addFormat({
    name,
    validate(value: unknown) {
      if (!isNumber(value) || !Number.isSafeInteger(value) || value < minimum)
        throw new Error(`expected a safe integer of at least ${minimum}`);
    },
  });
}

addMinimumFormat(
  ENVIRONMENT_BUILD_TIMEOUT_MS_FORMAT,
  ENVIRONMENT_BUILD_TIMEOUT_MS_MIN,
);
addMinimumFormat(ENVIRONMENT_MEMORY_MB_FORMAT, ENVIRONMENT_MEMORY_MB_MIN);

export const projectConfigSchema: Schema<ProjectConfig> = {
  environment_build_timeout_ms: {
    doc: "Deadline of one run of the Onboarding component in milliseconds.",
    format: ENVIRONMENT_BUILD_TIMEOUT_MS_FORMAT,
    default: DEFAULT_ENVIRONMENT_BUILD_TIMEOUT_MS,
  },
  environment_memory_mb: {
    doc: "Memory bound in megabytes of the layer build, the image check and the proof container.",
    format: ENVIRONMENT_MEMORY_MB_FORMAT,
    default: DEFAULT_ENVIRONMENT_MEMORY_MB,
  },
};
