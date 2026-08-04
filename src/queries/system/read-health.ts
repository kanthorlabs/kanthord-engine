export type DependencyStatus = "ok" | "failed" | "not-implemented";

export type DependencyReporter = Readonly<{
  name: string;
  probe: () => DependencyStatus;
}>;

export type ReadHealthDependencies = Readonly<{
  reporters: readonly DependencyReporter[];
}>;

export type DependencyLine = Readonly<{
  name: string;
  status: DependencyStatus;
}>;

export type ReadHealthResult = Readonly<{
  status: "ok" | "degraded";
  dependencies: readonly DependencyLine[];
}>;

export function readHealth(
  dependencies: ReadHealthDependencies,
): ReadHealthResult {
  const lines: DependencyLine[] = dependencies.reporters.map((reporter) => {
    let status: DependencyStatus;
    try {
      status = reporter.probe();
    } catch {
      status = "failed";
    }
    return { name: reporter.name, status };
  });
  lines.sort((a, b) =>
    Buffer.compare(Buffer.from(a.name, "utf8"), Buffer.from(b.name, "utf8")),
  );
  const status: "ok" | "degraded" = lines.some(
    (line) => line.status === "failed",
  )
    ? "degraded"
    : "ok";
  return { status, dependencies: lines };
}
