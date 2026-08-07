export const healthStatuses = ["ok", "degraded"] as const;
export const dependencyStatuses = ["ok", "failed", "not-implemented"] as const;

export type DependencyStatus = (typeof dependencyStatuses)[number];

export type DependencyLine = Readonly<{
  name: string;
  status: DependencyStatus;
}>;

export type HealthResult = Readonly<{
  status: (typeof healthStatuses)[number];
  dependencies: readonly DependencyLine[];
}>;
