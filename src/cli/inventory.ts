export type DeclaredCommand = Readonly<{
  path: readonly string[];
  operationIds: readonly string[];
}>;

export const declaredCommands: readonly DeclaredCommand[] = [
  {
    path: ["credential", "register"],
    operationIds: ["provider.register"],
  },
  {
    path: ["db", "migrate"],
    operationIds: [],
  },
  {
    path: ["db", "status"],
    operationIds: ["system.db"],
  },
  {
    path: ["plan", "export"],
    operationIds: ["plan.export"],
  },
  {
    path: ["plan", "import"],
    operationIds: ["plan.revisions", "plan.validate", "plan.import"],
  },
  {
    path: ["project", "create"],
    operationIds: ["project.create"],
  },
  {
    path: ["project", "list"],
    operationIds: ["project.list"],
  },
  {
    path: ["project", "repository"],
    operationIds: ["repository.list", "project.repositories"],
  },
  {
    path: ["project", "show"],
    operationIds: ["project.show"],
  },
  {
    path: ["repository", "register"],
    operationIds: [
      "provider.list",
      "repository.inspect",
      "repository.register",
    ],
  },
  {
    path: ["repository", "show"],
    operationIds: ["repository.show"],
  },
  {
    path: ["run"],
    operationIds: ["run.start"],
  },
  {
    path: ["serve"],
    operationIds: [],
  },
  {
    path: ["status"],
    operationIds: ["system.status"],
  },
];

export function commandPaths(): readonly string[] {
  return declaredCommands.map((entry) => entry.path.join(" "));
}
