import { isObject } from "./values.ts";
export const IdentityKind = {
  Human: "human",
  Client: "client",
  Service: "service",
} as const;
export const CLIENT_IDENTITY_PREFIX = "client_identity";
export const MAX_HUMAN_USERNAME_LENGTH = 64;
export const MAX_DISPLAY_NAME_LENGTH = 64;
export interface HumanIdentity {
  readonly kind: typeof IdentityKind.Human;
  readonly accountId: string;
  readonly name: string;
  readonly jti: string;
}
export interface MachineIdentity {
  readonly kind: typeof IdentityKind.Client;
  readonly clientId: string;
  readonly name: string;
  readonly resourceIdentity: string;
  readonly issuedAt: number;
  readonly projectId: string;
  readonly runtimeIdentity?: string;
  readonly jti: string;
}
export interface ServiceIdentity {
  readonly kind: typeof IdentityKind.Service;
  readonly service: string;
}
export type CallerIdentity = HumanIdentity | MachineIdentity | ServiceIdentity;
const humans = new WeakSet<object>();
const machines = new WeakSet<object>();
const services = new WeakSet<object>();

export function isHumanIdentity(value: unknown): value is HumanIdentity {
  return isObject(value) && humans.has(value);
}
export function isMachineIdentity(value: unknown): value is MachineIdentity {
  return isObject(value) && machines.has(value);
}
export function isServiceIdentity(value: unknown): value is ServiceIdentity {
  return isObject(value) && services.has(value);
}

export const callerProvenance = Object.freeze({
  human: humans.add.bind(humans),
  machine: machines.add.bind(machines),
  service: services.add.bind(services),
});
