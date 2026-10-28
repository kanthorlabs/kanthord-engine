import type { Writable } from "node:stream";
import type { MessagePort } from "node:worker_threads";
import type {
  PlacementStatus,
  PoolEntry,
  PoolInstance,
  PoolPlacement,
} from "../../worker/contract.ts";
import type { SlotControl } from "../worker/thread-data.ts";

export interface SlotEntry extends PoolEntry {
  readonly channel: MessagePort | null;
  readonly client_secret: string;
}

export interface SlotLaunch {
  readonly instance: PoolInstance;
  readonly entries: readonly SlotEntry[];
  readonly root: string;
  readonly output: Writable;
  readonly environment: NodeJS.ProcessEnv;
}

export interface SlotExit {
  readonly code: number;
  readonly error: Error | null;
}

export interface SlotInstance {
  control(kind: SlotControl["kind"]): void;
  bindings(entries: readonly SlotEntry[]): void;
  terminate(): void;
  readonly exited: Promise<SlotExit>;
}

export interface SlotDriver {
  readonly placement: PoolPlacement;
  check(): Promise<PlacementStatus>;
  prepare(): Promise<void>;
  removeVolume(instanceName: string): Promise<void>;
  sweepVolumes(live: ReadonlySet<string>): Promise<void>;
  launch(launch: SlotLaunch): SlotInstance;
  imageOf?(instanceName: string): string | null;
}
