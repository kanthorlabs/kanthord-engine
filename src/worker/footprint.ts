import { stat as fileStat, statfs as fileStatfs } from "node:fs/promises";
import type { Logger } from "pino";
import type { HumanActor } from "../kernel/actor.ts";
import { CleanupRefusal, type OwnerDeleteAnswer } from "../kernel/cleanup.ts";
import {
  type CandidatePage,
  type CandidateQuery,
  CleanupRule,
  DAY_MS,
  DEFAULT_AGE_DAYS,
  emptyMeasure,
  failedMeasure,
  FootprintKind,
  type FootprintMeasure,
  type FootprintOwner,
  itemsMeasure,
  RUNTIME_STORE_DEVICE,
} from "../footprint/contract.ts";
import {
  ContainerRuntime,
  type PoolHost,
  type PoolInstance,
  type RuntimeStoreInfo,
} from "./contract.ts";

export const WorkerFootprintErrorCode = {
  RuntimeUnmeasured: "worker.footprint.runtime_unmeasured",
  RuntimeStoreUnmeasured: "runtime_store_unmeasured",
  SessionUnmeasured: "worker.footprint.session_unmeasured",
} as const;
const DELETED = "worker.footprint.deleted";
const DOCKER_DESKTOP = "Docker Desktop";
const LINUX: NodeJS.Platform = "linux";
const TAG_SEPARATOR = ":";
const PATH_SEPARATOR = "/";
const NO_TIME = 0;
const NO_CONTAINERS = 0;
const FIRST_REFERENCE = 0;
const NO_BYTES = 0;

export interface StoreDevice {
  stat(path: string): Promise<{ dev: number | bigint }>;
  statfs(
    path: string,
  ): Promise<{ blocks: number; bsize: number; bavail: number }>;
}

export interface WorkerFootprintDependencies {
  readonly host: () => PoolHost | null;
  readonly configuredImage: string;
  readonly containerInstances: () => readonly string[];
  readonly serverInstances: () => readonly PoolInstance[];
  readonly stateDevice?: () => Promise<string>;
  readonly platform: NodeJS.Platform;
  readonly logger: Logger;
  readonly device?: StoreDevice;
  readonly now?: () => number;
}

interface SlotImageItem {
  readonly key: string;
  readonly at: number;
  readonly bytes: number;
  readonly live: boolean;
}

interface StoreFields {
  readonly instance_names: string[];
  readonly runtime_store: boolean;
}

interface StoreMeasureScope {
  readonly info: RuntimeStoreInfo;
  readonly fields: StoreFields;
}

const systemDevice: StoreDevice = {
  stat: (path) => fileStat(path),
  statfs: (path) => fileStatfs(path),
};

export function repositoryOf(reference: string): string {
  const separator = reference.lastIndexOf(TAG_SEPARATOR);
  return separator > reference.lastIndexOf(PATH_SEPARATOR)
    ? reference.slice(0, separator)
    : reference;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unmeasuredStore(
  fields: StoreFields,
  message: string,
): FootprintMeasure {
  return failedMeasure(
    FootprintKind.Disk,
    WorkerFootprintErrorCode.RuntimeStoreUnmeasured,
    message,
    { ...fields, item_key: RUNTIME_STORE_DEVICE },
  );
}

export class WorkerFootprint implements FootprintOwner {
  readonly kinds: readonly FootprintKind[] = [
    FootprintKind.SlotImage,
    FootprintKind.Disk,
    FootprintKind.Session,
  ];
  private readonly dependencies: WorkerFootprintDependencies;
  private readonly device: StoreDevice;
  private readonly now: () => number;

  constructor(dependencies: WorkerFootprintDependencies) {
    this.dependencies = dependencies;
    this.device = dependencies.device ?? systemDevice;
    this.now = dependencies.now ?? Date.now;
  }

  private async items(signal: AbortSignal): Promise<SlotImageItem[]> {
    const usage = await this.dependencies.host()?.runtimeUsage(signal);
    if (usage === null || usage === undefined)
      throw new Error("No container runtime answers.");
    const { configuredImage } = this.dependencies;
    const repository = repositoryOf(configuredImage);
    const items: SlotImageItem[] = [];
    for (const image of usage.images) {
      const references = image.references.filter(
        (reference) => repositoryOf(reference) === repository,
      );
      references.forEach((reference, index) =>
        items.push({
          key: reference,
          at: image.created_at ?? NO_TIME,
          bytes: index === FIRST_REFERENCE ? image.unique_bytes : NO_BYTES,
          live:
            image.containers > NO_CONTAINERS ||
            image.references.includes(configuredImage),
        }),
      );
    }
    return items.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
  }

  async measure(signal: AbortSignal): Promise<FootprintMeasure[]> {
    return [
      await this.measureImages(signal),
      ...(await this.measureStore(signal)),
      ...(await this.measureSessions(signal)),
    ];
  }

  private async measureSessions(
    signal: AbortSignal,
  ): Promise<FootprintMeasure[]> {
    const host = this.dependencies.host();
    const instances = this.dependencies.serverInstances();
    if (host === null || !instances.length) return [];
    const device =
      (await this.dependencies.stateDevice?.().catch(() => null)) ?? null;
    const measures: FootprintMeasure[] = [];
    for (const instance of instances) {
      const fields = { instance_name: instance.name, device };
      try {
        const items = (await host.sessionItems(instance, signal)).sort(
          (a, b) => a.modified_at - b.modified_at || a.key.localeCompare(b.key),
        );
        measures.push(
          itemsMeasure(
            FootprintKind.Session,
            items.map((item) => ({ bytes: item.bytes, at: item.modified_at })),
            this.now(),
            { ...fields, items },
          ),
        );
      } catch (error) {
        measures.push(
          failedMeasure(
            FootprintKind.Session,
            WorkerFootprintErrorCode.SessionUnmeasured,
            messageOf(error),
            fields,
          ),
        );
      }
    }
    return measures;
  }

  private async measureImages(signal: AbortSignal): Promise<FootprintMeasure> {
    const kind = FootprintKind.SlotImage;
    try {
      const items = await this.items(signal);
      const times = items.map((item) => item.at);
      const since = this.now() - DEFAULT_AGE_DAYS * DAY_MS;
      return emptyMeasure(kind, {
        device: RUNTIME_STORE_DEVICE,
        count: items.length,
        bytes: items.reduce((sum, item) => sum + item.bytes, 0),
        oldest_at: times.length ? Math.min(...times) : null,
        newest_at: times.length ? Math.max(...times) : null,
        recent_count: times.filter((at) => at >= since).length,
      });
    } catch (error) {
      return failedMeasure(
        kind,
        WorkerFootprintErrorCode.RuntimeUnmeasured,
        messageOf(error),
        { device: RUNTIME_STORE_DEVICE },
      );
    }
  }

  private async deviceKeyOf(path: string): Promise<string | null> {
    try {
      return String((await this.device.stat(path)).dev);
    } catch {
      return null;
    }
  }

  private async measureStore(signal: AbortSignal): Promise<FootprintMeasure[]> {
    const instances = [...this.dependencies.containerInstances()].sort();
    if (!instances.length) return [];
    const fields = { instance_names: instances, runtime_store: true };
    let info: RuntimeStoreInfo | null | undefined;
    try {
      info = await this.dependencies.host()?.runtimeStore(signal);
    } catch (error) {
      return [unmeasuredStore(fields, messageOf(error))];
    }
    if (info === null || info === undefined)
      return [unmeasuredStore(fields, "No container runtime answers.")];
    const scope: StoreMeasureScope = { info, fields };
    if (info.runtime === ContainerRuntime.Podman)
      return [await this.measurePodmanStore(scope)];
    return [await this.measureDockerStore(scope)];
  }

  private async measurePodmanStore(
    scope: StoreMeasureScope,
  ): Promise<FootprintMeasure> {
    const { info, fields } = scope;
    const { graph_root, graph_root_allocated, graph_root_used } = info;
    if (
      graph_root === null ||
      graph_root_allocated === null ||
      graph_root_used === null
    )
      return unmeasuredStore(fields, "podman info answers no graph root size.");
    return emptyMeasure(FootprintKind.Disk, {
      ...fields,
      item_key: (await this.deviceKeyOf(graph_root)) ?? RUNTIME_STORE_DEVICE,
      total_bytes: graph_root_allocated,
      free_bytes: Math.max(0, graph_root_allocated - graph_root_used),
    });
  }

  private async measureDockerStore(
    scope: StoreMeasureScope,
  ): Promise<FootprintMeasure> {
    const { info, fields } = scope;
    if (
      this.dependencies.platform !== LINUX ||
      info.operating_system === DOCKER_DESKTOP ||
      info.docker_root_dir === null
    )
      return unmeasuredStore(
        fields,
        "The Docker root directory is not on the server host.",
      );
    try {
      const space = await this.device.statfs(info.docker_root_dir);
      return emptyMeasure(FootprintKind.Disk, {
        ...fields,
        item_key:
          (await this.deviceKeyOf(info.docker_root_dir)) ??
          RUNTIME_STORE_DEVICE,
        total_bytes: space.blocks * space.bsize,
        free_bytes: space.bavail * space.bsize,
      });
    } catch (error) {
      return unmeasuredStore(fields, messageOf(error));
    }
  }

  async candidates(query: CandidateQuery): Promise<CandidatePage> {
    const items = await this.items(query.signal);
    const selected =
      query.rule === null
        ? items
        : query.rule.name === CleanupRule.Superseded
          ? items.filter((item) => !item.live)
          : [];
    return {
      items: selected
        .slice(query.offset, query.offset + query.limit)
        .map((item) => ({
          key: item.key,
          at: item.at,
          bytes: item.bytes,
          project_id: null,
          node_id: null,
          execution_id: null,
          refusal: item.live ? CleanupRefusal.Live : null,
          kept: false,
        })),
      total_count: selected.length,
      total_bytes: selected.reduce((sum, item) => sum + item.bytes, 0),
    };
  }

  async deleteSlotImages(
    references: readonly string[],
    requestedBy: HumanActor,
    signal: AbortSignal,
  ): Promise<OwnerDeleteAnswer> {
    const items = await this.items(signal);
    const answer: OwnerDeleteAnswer = { removed: 0, absent: 0, refused: [] };
    for (const reference of references) {
      const item = items.find((entry) => entry.key === reference);
      if (item === undefined) {
        answer.absent += 1;
        continue;
      }
      if (item.live) {
        answer.refused.push({ key: reference, reason: CleanupRefusal.Live });
        continue;
      }
      if (await this.dependencies.host()!.removeImage(reference))
        answer.removed += 1;
      else answer.absent += 1;
    }
    this.dependencies.logger.info(
      {
        operation: "worker.slot_image.delete",
        requested_by: requestedBy.account,
        removed: answer.removed,
        absent: answer.absent,
        refused: answer.refused.length,
      },
      DELETED,
    );
    return answer;
  }
}
