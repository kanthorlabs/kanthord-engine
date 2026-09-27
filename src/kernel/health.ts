import assert from "node:assert/strict";
import { z } from "zod";
import {
  background,
  CancellationContext,
  throwIfCancelled,
  type Context,
} from "./context.ts";
import { HealthStatus, type Healthcheck } from "./service.ts";
import { ValueType } from "./values.ts";

export const componentHealthSchema = z.record(
  z.string().min(1),
  z
    .union([
      z.literal(HealthStatus.Healthy),
      z.literal(HealthStatus.Unavailable),
    ])
    .describe("Component status: 200 healthy, 503 unavailable."),
);
type ComponentHealth = z.infer<typeof componentHealthSchema>;
export type ServiceHealthchecks = Record<string, ComponentHealth>;
export type HealthProbe = (
  context: Context,
) => Healthcheck | Promise<Healthcheck>;
export const MAX_HEALTH_PROBES = 128;
const MAX_TIMEOUT_MS = 5000;
const MIN_TIMEOUT_MS = 1;
const EMPTY_PROBE_COUNT = 0;
const EMPTY_COMPONENT_COUNT = 0;

/** Borrows probes; service owners retain responsibility for their resources. */
export class HealthRegistry {
  private readonly probes = new Map<string, HealthProbe>();
  private readonly timeoutMs: number;

  constructor(timeoutMs = MAX_TIMEOUT_MS) {
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < MIN_TIMEOUT_MS ||
      timeoutMs > MAX_TIMEOUT_MS
    )
      throw new RangeError(
        "Health probe timeout must be between 1 and 5000 ms.",
      );
    this.timeoutMs = timeoutMs;
    assert.equal(this.probes.size, EMPTY_PROBE_COUNT);
    assert.ok(this.timeoutMs <= MAX_TIMEOUT_MS);
  }

  register(name: string, probe: HealthProbe): void {
    if (!/^[a-z][a-z0-9-]*$/.test(name))
      throw new TypeError("Health registration requires a safe service name.");
    if (typeof probe !== ValueType.Function)
      throw new TypeError("Health registration requires a probe function.");
    if (this.probes.has(name))
      throw new Error("Duplicate health registration.");
    if (this.probes.size >= MAX_HEALTH_PROBES)
      throw new RangeError("Health registry capacity exceeded.");
    this.probes.set(name, probe);
    assert.equal(this.probes.get(name), probe);
    assert.ok(this.probes.size <= MAX_HEALTH_PROBES);
  }

  async check(context: Context = background): Promise<ServiceHealthchecks> {
    throwIfCancelled(context);
    // Snapshot registration once; a failed probe must not skip its siblings.
    const entries = [...this.probes];
    assert.ok(entries.length <= MAX_HEALTH_PROBES);
    const results = await Promise.all(
      entries.map(
        async ([name, probe]) =>
          [name, await this.probe(probe, context)] as const,
      ),
    );
    throwIfCancelled(context);
    const services = Object.fromEntries(results);
    assert.equal(Object.keys(services).length, entries.length);
    return services;
  }

  private async probe(
    probe: HealthProbe,
    parent: Context,
  ): Promise<ComponentHealth> {
    assert.equal(typeof probe, ValueType.Function);
    const context = new CancellationContext(
      parent,
      Date.now() + this.timeoutMs,
    );
    assert.ok(context.deadline() !== null);
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => {
          throwIfCancelled(context);
          return probe(context);
        }),
        context.done().then(() => {
          throw context.err();
        }),
      ]);
      const components = componentHealthSchema.parse(result);
      if (Object.keys(components).length === EMPTY_COMPONENT_COUNT)
        throw new Error("Health probe returned no components.");
      return components;
    } catch {
      // Diagnostic boundary: rejection, invalid output and timeout are failures,
      // never a healthy fallback. Do not expose probe exceptions on a public API.
      throwIfCancelled(parent);
      return { healthcheck: HealthStatus.Unavailable };
    } finally {
      context.cancel();
    }
  }
}

export const ResourceStatus = {
  Healthy: "healthy",
  Unhealthy: "unhealthy",
  Unknown: "unknown",
} as const;
export type ResourceStatusValue =
  (typeof ResourceStatus)[keyof typeof ResourceStatus];

export const HealthScope = {
  Global: "global",
  Project: "project",
} as const;
export type HealthScopeValue = (typeof HealthScope)[keyof typeof HealthScope];

export type ResourceCheck = (context: Context) => Promise<ResourceStatusValue>;

export interface ResourceEntry {
  scope: HealthScopeValue;
  project: string | null;
  name: string;
  target: string;
  capability: string;
  check: ResourceCheck;
}
