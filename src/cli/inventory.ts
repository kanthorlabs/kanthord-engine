export type DeclaredCommand = Readonly<{
  path: readonly string[];
  operationIds: readonly string[];
}>;

export const declaredCommands: readonly DeclaredCommand[] = [
  {
    path: ["actor", "list"],
    operationIds: ["actor.list"],
  },
  {
    path: ["actor", "register"],
    operationIds: ["actor.register"],
  },
  {
    path: ["actor", "revoke"],
    operationIds: ["actor.revoke"],
  },
  {
    path: ["actor", "rotate"],
    operationIds: ["actor.rotate"],
  },
  {
    path: ["actor", "show"],
    operationIds: ["actor.show"],
  },
  {
    path: ["config", "generate"],
    operationIds: [],
  },
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
    path: ["node", "attest"],
    operationIds: ["node.report"],
  },
  {
    path: ["node", "claim"],
    operationIds: ["node.claim"],
  },
  {
    path: ["node", "close"],
    operationIds: ["node.report"],
  },
  {
    path: ["node", "create"],
    operationIds: ["plan.revisions", "node.create"],
  },
  {
    path: ["node", "delete"],
    operationIds: ["node.show", "plan.revisions", "node.delete"],
  },
  {
    path: ["node", "heartbeat"],
    operationIds: ["node.heartbeat"],
  },
  {
    path: ["node", "list"],
    operationIds: ["node.list"],
  },
  {
    path: ["node", "release"],
    operationIds: ["node.release"],
  },
  {
    path: ["node", "report"],
    operationIds: ["node.report"],
  },
  {
    path: ["node", "show"],
    operationIds: ["node.show"],
  },
  {
    path: ["node", "unblock"],
    operationIds: ["node.unblock"],
  },
  {
    path: ["node", "update"],
    operationIds: ["node.show", "plan.revisions", "node.update"],
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
