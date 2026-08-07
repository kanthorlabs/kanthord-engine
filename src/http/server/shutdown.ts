export type ShutdownStep = Readonly<{
  name: string;
  run: () => void | Promise<void>;
}>;

export type ShutdownDependencies = Readonly<{
  steps: readonly ShutdownStep[];
  write: (text: string) => void;
  onSettled: (code: number) => void;
}>;

export function createShutdown(
  dependencies: ShutdownDependencies,
): () => Promise<void> {
  let started: Promise<void> | null = null;

  const run = async (): Promise<void> => {
    let failed = false;
    for (const step of dependencies.steps) {
      try {
        await step.run();
      } catch (error) {
        failed = true;
        dependencies.write(
          `kanthord: shutdown: ${step.name} failed: ${String(error)}\n`,
        );
      }
    }
    if (failed) {
      dependencies.onSettled(1);
      return;
    }
    dependencies.write("kanthord: stopped\n");
    dependencies.onSettled(0);
  };

  return (): Promise<void> => {
    if (started === null) {
      started = run();
    }
    return started;
  };
}
