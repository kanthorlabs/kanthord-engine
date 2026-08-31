export type HarnessDescriptor = Readonly<{
  id: string;
  denyByDefault: boolean;
}>;

export const harnesses: readonly [
  HarnessDescriptor,
  HarnessDescriptor,
  HarnessDescriptor,
] = [
  { id: "claude-code", denyByDefault: true },
  { id: "opencode", denyByDefault: true },
  { id: "pi", denyByDefault: false },
];
