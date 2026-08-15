import type { RegisteredActorKind } from "./actor.ts";

export type ActorView = Readonly<{
  id: string;
  kind: RegisteredActorKind;
  name: string;
  registeredBy: string | null;
  createdAt: number;
  revokedAt: number | null;
  revokedBy: string | null;
}>;
