import type { ProviderKind, ProviderProjection } from "./provider-payload.ts";

export type ProviderView = Readonly<{
  id: string;
  name: string;
  kind: ProviderKind;
  projection: ProviderProjection | null;
  setDefaultAt: number | null;
  updatedAt: number;
}>;
