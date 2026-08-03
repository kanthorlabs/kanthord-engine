export type Migration = Readonly<{
  version: number;
  name: string;
  statements: readonly string[];
}>;
