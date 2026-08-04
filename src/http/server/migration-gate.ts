export type PendingEntry = Readonly<{ version: number; name: string }>;

export type StartupErrorCode = "db-migration-pending";

export class StartupError extends Error {
  readonly code: StartupErrorCode;

  constructor(code: StartupErrorCode, message: string) {
    super(message);
    this.name = "StartupError";
    this.code = code;
  }
}

export function assertMigrated(
  input: Readonly<{ home: string; pending: readonly PendingEntry[] }>,
): void {
  if (input.pending.length === 0) {
    return;
  }
  const names = [...input.pending]
    .sort((a, b) => a.version - b.version)
    .map((entry) => entry.name)
    .join(", ");
  throw new StartupError(
    "db-migration-pending",
    `the daemon home ${input.home} has unapplied migrations ${names}; run kanthord db migrate`,
  );
}
