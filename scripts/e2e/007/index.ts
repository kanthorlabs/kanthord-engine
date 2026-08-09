export type ScenarioId =
  | "E7-00a"
  | "E7-00b"
  | "E7-01"
  | "E7-03"
  | "E7-04"
  | "E7-05"
  | "E7-06"
  | "E7-07"
  | "E7-08"
  | "E7-09"
  | "E7-10"
  | "E7-11"
  | "E7-12";

export type ScenarioDeclaration = Readonly<{
  id: ScenarioId;
  story: string;
  file: string;
  goal: string;
  writesRemoteRef: boolean;
}>;

export const scenarios: readonly ScenarioDeclaration[] = [
  {
    id: "E7-00a",
    story: "02",
    file: "00-harness.e2e.ts",
    goal: "the token reads the named repository, a wrong one does not",
    writesRemoteRef: false,
  },
  {
    id: "E7-00b",
    story: "02",
    file: "00-harness.e2e.ts",
    goal: "the cleanup removes what the gate creates",
    writesRemoteRef: true,
  },
  {
    id: "E7-01",
    story: "01",
    file: "01-tool-probe.e2e.ts",
    goal: "the real tools resolve and satisfy the version floor",
    writesRemoteRef: false,
  },
  {
    id: "E7-03",
    story: "03",
    file: "03-provider-kind-factory.e2e.ts",
    goal: "the real token round-trips through canonical serialization",
    writesRemoteRef: false,
  },
  {
    id: "E7-04",
    story: "04",
    file: "04-credential-routes.e2e.ts",
    goal: "the credential is stored encrypted and never read back",
    writesRemoteRef: false,
  },
  {
    id: "E7-05",
    story: "05",
    file: "05-host-key-discovery.e2e.ts",
    goal: "a real host scan is ordered, reproducible and tool-agreeing",
    writesRemoteRef: false,
  },
  {
    id: "E7-06",
    story: "06",
    file: "06-repository-inspect.e2e.ts",
    goal: "the real default branch is detected; a dead token is a verdict",
    writesRemoteRef: false,
  },
  {
    id: "E7-07",
    story: "07",
    file: "07-registration-preflight.e2e.ts",
    goal: "the write advertisement passes, refuses, and writes nothing",
    writesRemoteRef: false,
  },
  {
    id: "E7-08",
    story: "08",
    file: "08-host-key-confirmation.e2e.ts",
    goal: "the re-scan is load-bearing against the real host",
    writesRemoteRef: false,
  },
  {
    id: "E7-09",
    story: "09",
    file: "09-bare-home-seeding.e2e.ts",
    goal: "one landing branch, a full tracking namespace, no tag",
    writesRemoteRef: false,
  },
  {
    id: "E7-10",
    story: "10",
    file: "10-repository-register.e2e.ts",
    goal: "registration writes the row, and refuses without writing one",
    writesRemoteRef: false,
  },
  {
    id: "E7-11",
    story: "11",
    file: "11-repository-projection.e2e.ts",
    goal: "P1-E5: the ref layout through the route alone",
    writesRemoteRef: false,
  },
  {
    id: "E7-12",
    story: "12",
    file: "12-cli-commands.e2e.ts",
    goal: "the real CLI exits non-zero and names the missing flag",
    writesRemoteRef: false,
  },
];
