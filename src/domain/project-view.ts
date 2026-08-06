export type ProjectView = Readonly<{
  id: string;
  name: string;
  repositories: readonly string[];
  updatedAt: number;
}>;
