export type AcceptanceCheck<T> = Readonly<{
  name: string;
  run(subject: T): Promise<void> | void;
}>;

export type AcceptanceFailure = Readonly<{ name: string; reason: string }>;

export class FixtureError extends Error {
  readonly failures: readonly AcceptanceFailure[];

  constructor(
    fixture: string,
    failures: readonly AcceptanceFailure[],
    totalChecks: number = failures.length,
  ) {
    const message =
      totalChecks === 0
        ? `${fixture}: ${failures.map((failure) => failure.reason).join(", ")}`
        : `${fixture} failed ${failures.length} of ${totalChecks} acceptance checks: ${failures
            .map((failure) => failure.name)
            .join(", ")}`;
    super(message);
    this.name = "FixtureError";
    this.failures = failures;
  }
}

export async function runAcceptance<T>(
  fixture: string,
  subject: T,
  checks: readonly AcceptanceCheck<T>[],
): Promise<void> {
  if (checks.length === 0) {
    throw new FixtureError(
      fixture,
      [{ name: "acceptance", reason: "the check list is empty" }],
      0,
    );
  }
  const failures: AcceptanceFailure[] = [];
  for (const check of checks) {
    try {
      await check.run(subject);
    } catch (error) {
      failures.push({
        name: check.name,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (failures.length > 0) {
    throw new FixtureError(fixture, failures, checks.length);
  }
}
