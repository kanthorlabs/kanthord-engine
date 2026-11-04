import { lstat } from "node:fs/promises";
import { join } from "node:path";
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
  type FootprintCandidate,
  FootprintKind,
  type FootprintMeasure,
  type FootprintOwner,
  RUNTIME_STORE_DEVICE,
} from "../footprint/contract.ts";
import type { RuntimeImageUsage } from "../worker/contract.ts";
import {
  BASE_SUFFIX,
  ENVIRONMENT_IMAGE_PREFIX,
  type EnvironmentCacheVolume,
  environmentPath,
  type EnvironmentRuntime,
  type ProofFiles,
  PROVED_SUFFIX,
  UNCHECKED_SUFFIX,
} from "./environment-state.ts";

export const PROJECT_FOOTPRINT_UNMEASURED =
  "project.footprint.runtime_unmeasured";
const DELETED = "project.footprint.deleted";
const IMAGE_ID_PREFIX = "sha256:";
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const KEY_SEPARATOR = "@";
const TAG_SEPARATOR = ":";
const PROOF_EXTENSION = ".json";
const FILE_NOT_FOUND = "ENOENT";
const TAG_SUFFIXES = [BASE_SUFFIX, PROVED_SUFFIX, UNCHECKED_SUFFIX];
const NO_TIME = 0;
const NO_CONTAINERS = 0;
const NO_LINKS = 0;
const NO_SEPARATOR = 0;

export interface BoundRepository {
  readonly project_id: string;
  readonly resource_identity: string;
  readonly digest: string | null;
}

export interface ProjectFootprintDependencies {
  readonly runtime: Pick<
    EnvironmentRuntime,
    "footprintUsage" | "removeImage" | "removeTags" | "removeCacheVolume"
  >;
  readonly proofs: Pick<ProofFiles, "paths" | "digests" | "remove">;
  readonly proofRoot: string;
  readonly bound: () => readonly BoundRepository[];
  readonly logger: Logger;
  readonly now?: () => number;
}

interface EnvironmentItem {
  readonly key: string;
  readonly path: string | null;
  readonly digest: string | null;
  at: number;
  bytes: number;
  proof: boolean;
  live: boolean;
}

interface CacheItem {
  readonly key: string;
  readonly at: number;
  readonly bytes: number;
  readonly live: boolean;
  readonly unbound: boolean;
  readonly volume: EnvironmentCacheVolume;
}

function hexOf(id: string): string {
  return id.startsWith(IMAGE_ID_PREFIX) ? id.slice(IMAGE_ID_PREFIX.length) : id;
}

function sameImage(left: string, right: string): boolean {
  const a = hexOf(left);
  const b = hexOf(right);
  return a.length <= b.length ? b.startsWith(a) : a.startsWith(b);
}

function digestOfTag(tag: string): string | null {
  const suffix = TAG_SUFFIXES.find((candidate) => tag.endsWith(candidate));
  const digest = suffix === undefined ? tag : tag.slice(0, -suffix.length);
  return DIGEST.test(digest) ? digest : null;
}

function environmentKeyOf(
  reference: string,
): { path: string; digest: string } | null {
  const prefix = `${ENVIRONMENT_IMAGE_PREFIX}/`;
  if (!reference.startsWith(prefix)) return null;
  const rest = reference.slice(prefix.length);
  const separator = rest.lastIndexOf(TAG_SEPARATOR);
  if (separator <= NO_SEPARATOR) return null;
  const digest = digestOfTag(rest.slice(separator + 1));
  return digest === null ? null : { path: rest.slice(0, separator), digest };
}

function tagsOf(path: string, digest: string): string[] {
  const tag = `${ENVIRONMENT_IMAGE_PREFIX}/${path}${TAG_SEPARATOR}${digest}`;
  return [tag, ...TAG_SUFFIXES.map((suffix) => `${tag}${suffix}`)];
}

function pairKey(projectId: string, resourceIdentity: string): string {
  return JSON.stringify([projectId, resourceIdentity]);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function candidate(
  key: string,
  at: number,
  bytes: number,
  live: boolean,
): FootprintCandidate {
  return {
    key,
    at,
    bytes,
    project_id: null,
    node_id: null,
    execution_id: null,
    refusal: live ? CleanupRefusal.Live : null,
    kept: false,
  };
}

function page<T extends { at: number; bytes: number }>(
  items: readonly T[],
  query: CandidateQuery,
  view: (item: T) => FootprintCandidate,
): CandidatePage {
  const sorted = [...items].sort((a, b) => a.at - b.at);
  return {
    items: sorted.slice(query.offset, query.offset + query.limit).map(view),
    total_count: sorted.length,
    total_bytes: sorted.reduce((sum, item) => sum + item.bytes, 0),
  };
}

export class ProjectFootprint implements FootprintOwner {
  readonly kinds: readonly FootprintKind[] = [
    FootprintKind.Environment,
    FootprintKind.CacheVolume,
  ];
  private readonly dependencies: ProjectFootprintDependencies;
  private readonly now: () => number;

  constructor(dependencies: ProjectFootprintDependencies) {
    this.dependencies = dependencies;
    this.now = dependencies.now ?? Date.now;
  }

  boundPaths(): string[] {
    return [
      ...new Set(
        this.dependencies
          .bound()
          .map((entry) => environmentPath(entry.resource_identity)),
      ),
    ].sort();
  }

  private liveKeys(): Set<string> {
    const keys = new Set<string>();
    for (const entry of this.dependencies.bound())
      if (entry.digest !== null)
        keys.add(
          `${environmentPath(entry.resource_identity)}${KEY_SEPARATOR}${entry.digest}`,
        );
    return keys;
  }

  private proofPaths(): string[] {
    try {
      return this.dependencies.proofs.paths();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === FILE_NOT_FOUND) return [];
      throw error;
    }
  }

  private async proofStat(
    path: string,
    digest: string,
  ): Promise<{ bytes: number; at: number } | null> {
    try {
      const stats = await lstat(
        join(this.dependencies.proofRoot, path, `${digest}${PROOF_EXTENSION}`),
      );
      return stats.isFile()
        ? { bytes: stats.size, at: Math.floor(stats.mtimeMs) }
        : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === FILE_NOT_FOUND) return null;
      throw error;
    }
  }

  private async read(signal: AbortSignal): Promise<{
    environments: EnvironmentItem[];
    caches: CacheItem[];
  }> {
    const { usage, owned_image_ids, cache_volumes } =
      await this.dependencies.runtime.footprintUsage(signal);
    const owned = usage.images.flatMap((image): RuntimeImageUsage[] => {
      const id = owned_image_ids.find((candidate) =>
        sameImage(candidate, image.id),
      );
      return id === undefined ? [] : [{ ...image, id }];
    });
    const live = this.liveKeys();
    const items = new Map<string, EnvironmentItem>();
    const itemOf = (path: string, digest: string) => {
      const key = `${path}${KEY_SEPARATOR}${digest}`;
      let item = items.get(key);
      if (item === undefined) {
        item = {
          key,
          path,
          digest,
          at: NO_TIME,
          bytes: 0,
          proof: false,
          live: live.has(key),
        };
        items.set(key, item);
      }
      return item;
    };
    for (const image of owned) {
      const keys = new Set<EnvironmentItem>();
      for (const reference of image.references) {
        const found = environmentKeyOf(reference);
        if (found !== null) keys.add(itemOf(found.path, found.digest));
      }
      const first = [...keys].at(0);
      if (first === undefined) {
        if (image.references.length || !IMAGE_ID.test(image.id)) continue;
        items.set(image.id, {
          key: image.id,
          path: null,
          digest: null,
          at: image.created_at ?? NO_TIME,
          bytes: image.unique_bytes,
          proof: false,
          live: image.containers > NO_CONTAINERS,
        });
        continue;
      }
      first.bytes += image.unique_bytes;
      for (const item of keys) {
        item.at = Math.max(item.at, image.created_at ?? NO_TIME);
        if (image.containers > NO_CONTAINERS) item.live = true;
      }
    }
    for (const path of this.proofPaths())
      for (const digest of this.dependencies.proofs.digests(path)) {
        signal.throwIfAborted();
        const proof = await this.proofStat(path, digest);
        if (proof === null || !DIGEST.test(digest)) continue;
        const item = itemOf(path, digest);
        item.bytes += proof.bytes;
        item.proof = true;
        if (item.at === NO_TIME) item.at = proof.at;
      }
    const boundPairs = new Set(
      this.dependencies
        .bound()
        .map((entry) => pairKey(entry.project_id, entry.resource_identity)),
    );
    const caches = cache_volumes.map((volume): CacheItem => {
      const used = usage.volumes.find((entry) => entry.name === volume.name);
      const unbound = !boundPairs.has(
        pairKey(volume.project_id, volume.resource_identity),
      );
      return {
        key: volume.name,
        at: volume.created_at ?? NO_TIME,
        bytes: used?.bytes ?? 0,
        live: !unbound || (used?.links ?? NO_LINKS) > NO_LINKS,
        unbound,
        volume,
      };
    });
    return { environments: [...items.values()], caches };
  }

  async measure(signal: AbortSignal): Promise<FootprintMeasure[]> {
    try {
      const { environments, caches } = await this.read(signal);
      return [
        this.measureOf(FootprintKind.Environment, environments),
        this.measureOf(FootprintKind.CacheVolume, caches),
      ];
    } catch (error) {
      return this.kinds.map((kind) =>
        failedMeasure(kind, PROJECT_FOOTPRINT_UNMEASURED, messageOf(error), {
          device: RUNTIME_STORE_DEVICE,
        }),
      );
    }
  }

  private measureOf(
    kind: FootprintKind,
    items: readonly { at: number; bytes: number }[],
  ): FootprintMeasure {
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
  }

  private selected(
    items: readonly EnvironmentItem[],
    rule: CandidateQuery["rule"],
  ): EnvironmentItem[] {
    if (rule === null) return [...items];
    const bound = new Set(this.boundPaths());
    const provedLive = new Set(
      items
        .filter((item) => item.live && item.proof && item.path !== null)
        .map((item) => item.path),
    );
    return items.filter((item) => {
      if (item.live || item.path === null) return false;
      if (rule.name === CleanupRule.Unbound) return !bound.has(item.path);
      if (rule.name === CleanupRule.Superseded)
        return bound.has(item.path) && provedLive.has(item.path);
      return false;
    });
  }

  async candidates(query: CandidateQuery): Promise<CandidatePage> {
    const { environments, caches } = await this.read(query.signal);
    if (query.kind === FootprintKind.CacheVolume)
      return page(
        query.rule === null
          ? caches
          : query.rule.name === CleanupRule.Unbound
            ? caches.filter((item) => item.unbound && !item.live)
            : [],
        query,
        (item) => candidate(item.key, item.at, item.bytes, item.live),
      );
    return page(this.selected(environments, query.rule), query, (item) =>
      candidate(item.key, item.at, item.bytes, item.live),
    );
  }

  private logged(
    operation: string,
    requestedBy: HumanActor,
    answer: OwnerDeleteAnswer,
  ): OwnerDeleteAnswer {
    this.dependencies.logger.info(
      {
        operation,
        requested_by: requestedBy.account,
        removed: answer.removed,
        absent: answer.absent,
        refused: answer.refused.length,
      },
      DELETED,
    );
    return answer;
  }

  async deleteEnvironments(
    keys: readonly string[],
    requestedBy: HumanActor,
    signal: AbortSignal,
  ): Promise<OwnerDeleteAnswer> {
    const { environments } = await this.read(signal);
    const answer: OwnerDeleteAnswer = { removed: 0, absent: 0, refused: [] };
    for (const key of keys) {
      const item = environments.find((entry) => entry.key === key);
      if (item === undefined) {
        answer.absent += 1;
        continue;
      }
      if (item.live) {
        answer.refused.push({ key, reason: CleanupRefusal.Live });
        continue;
      }
      if (item.path === null || item.digest === null) {
        if (await this.dependencies.runtime.removeImage(key))
          answer.removed += 1;
        else answer.absent += 1;
        continue;
      }
      await this.dependencies.runtime.removeTags(
        tagsOf(item.path, item.digest),
      );
      this.dependencies.proofs.remove(item.path, item.digest);
      answer.removed += 1;
    }
    return this.logged("project.environment.delete", requestedBy, answer);
  }

  async deleteCacheVolumes(
    names: readonly string[],
    requestedBy: HumanActor,
    signal: AbortSignal,
  ): Promise<OwnerDeleteAnswer> {
    const { caches } = await this.read(signal);
    const answer: OwnerDeleteAnswer = { removed: 0, absent: 0, refused: [] };
    for (const name of names) {
      const item = caches.find((entry) => entry.key === name);
      if (item === undefined) {
        answer.absent += 1;
        continue;
      }
      if (item.live) {
        answer.refused.push({ key: name, reason: CleanupRefusal.Live });
        continue;
      }
      await this.dependencies.runtime.removeCacheVolume(
        item.volume.project_id,
        item.volume.resource_identity,
      );
      answer.removed += 1;
    }
    return this.logged(
      "project.environment.cache_volume.delete",
      requestedBy,
      answer,
    );
  }
}
