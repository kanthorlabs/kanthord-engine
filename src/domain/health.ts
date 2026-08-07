export type DependencyStatus = "ok" | "failed" | "not-implemented";

export type DependencyLine = Readonly<{
  name: string;
  status: DependencyStatus;
}>;

export type HealthResult = Readonly<{
  status: "ok" | "degraded";
  dependencies: readonly DependencyLine[];
}>;
