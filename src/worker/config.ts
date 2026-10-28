import type { Schema } from "convict";
import { isNumber, isString } from "../kernel/values.ts";

export interface WorkerConfig {
  heartbeat_window: number;
  server_instance_limit: number;
  container_image: string;
}

const DEFAULT_HEARTBEAT_WINDOW = 300;
const DEFAULT_SERVER_INSTANCE_LIMIT = 16;
const NO_VALUE = 0;
const DEFAULT_CONTAINER_IMAGE = "docker.io/kanthorlabs/kanthord";
const DIGEST_SEPARATOR = "@";
const TAG_SEPARATOR = ":";
const PATH_SEPARATOR = "/";

function positiveSafeInteger(value: unknown): void {
  if (!isNumber(value) || !Number.isSafeInteger(value) || value <= NO_VALUE)
    throw new Error("expected a positive safe integer");
}

function imageName(value: unknown): void {
  if (!isString(value) || !value) throw new Error("expected an image name");
  const lastComponent = value.slice(value.lastIndexOf(PATH_SEPARATOR) + 1);
  if (value.includes(DIGEST_SEPARATOR) || lastComponent.includes(TAG_SEPARATOR))
    throw new Error("expected an image name with no tag and no digest");
}

export const workerConfigSchema: Schema<WorkerConfig> = {
  heartbeat_window: {
    doc: "Registration heartbeat window in seconds.",
    format: positiveSafeInteger,
    default: DEFAULT_HEARTBEAT_WINDOW,
  },
  server_instance_limit: {
    doc: "Maximum count of live server instances.",
    format: positiveSafeInteger,
    default: DEFAULT_SERVER_INSTANCE_LIMIT,
  },
  container_image: {
    doc: "Image name of the container placement, with no tag and no digest.",
    format: imageName,
    default: DEFAULT_CONTAINER_IMAGE,
  },
};
