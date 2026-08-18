export type ScenarioClock = Readonly<{
  now(): number;
  wait(ms: number): Promise<void>;
}>;

export const realClock: ScenarioClock = {
  now: () => Date.now(),
  wait: (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    }),
};
