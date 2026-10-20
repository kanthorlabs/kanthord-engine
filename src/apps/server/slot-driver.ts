import type { Writable } from "node:stream";
import type { MessagePort } from "node:worker_threads";
import type {
  PlacementStatus,
  PoolPlacement,
  PoolSlot,
} from "../../worker/contract.ts";
import type { SlotControl } from "../worker/thread-data.ts";

export interface SlotLaunch {
  readonly slot: PoolSlot;
  readonly channel: MessagePort;
  readonly client_secret: string;
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
  terminate(): void;
  readonly exited: Promise<SlotExit>;
}

export interface SlotDriver {
  readonly placement: PoolPlacement;
  check(): Promise<PlacementStatus>;
  prepare(): Promise<void>;
  launch(launch: SlotLaunch): SlotInstance;
}
