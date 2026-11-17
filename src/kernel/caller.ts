import { isObject } from "./values.ts";
export const IdentityKind = {
  Human: "human",
  Client: "client",
  Worker: "worker",
  Guest: "guest",
  Service: "service",
} as const;
export const CLIENT_IDENTITY_PREFIX = "client_identity";
export const WORKER_INSTANCE_PREFIX = "worker_instance";
export const CONNECTION_PREFIX = "connection";
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
  readonly instanceId?: string;
  readonly connectionId?: string;
  readonly jti: string;
}
export interface WorkerIdentity {
  readonly kind: typeof IdentityKind.Worker;
  readonly instanceId: string;
  readonly name: string;
  readonly jti: string;
}
export interface GuestIdentity {
  readonly kind: typeof IdentityKind.Guest;
  readonly guestId: string;
  readonly name: string;
  readonly inviteId: string;
  readonly sessionId: string;
  readonly invitedBy: string;
  readonly reader: HumanIdentity;
  readonly jti: string;
}
export interface ServiceIdentity {
  readonly kind: typeof IdentityKind.Service;
  readonly service: string;
}
export type CallerIdentity =
  | HumanIdentity
  | MachineIdentity
  | WorkerIdentity
  | GuestIdentity
  | ServiceIdentity;
const humans = new WeakSet<object>();
const machines = new WeakSet<object>();
const workers = new WeakSet<object>();
const guests = new WeakSet<object>();
const services = new WeakSet<object>();
interface ReaderMark {
  inviteId: string;
  projects: ReadonlySet<string>;
}
const readers = new WeakMap<object, ReaderMark>();

export function isHumanIdentity(value: unknown): value is HumanIdentity {
  return isObject(value) && humans.has(value);
}
export function isMachineIdentity(value: unknown): value is MachineIdentity {
  return isObject(value) && machines.has(value);
}
export function isWorkerIdentity(value: unknown): value is WorkerIdentity {
  return isObject(value) && workers.has(value);
}
export function isGuestIdentity(value: unknown): value is GuestIdentity {
  return isObject(value) && guests.has(value);
}
export function isServiceIdentity(value: unknown): value is ServiceIdentity {
  return isObject(value) && services.has(value);
}
export function isReadOnlyIdentity(value: unknown): boolean {
  return isObject(value) && readers.has(value);
}
export function projectScopeOf(
  identity: CallerIdentity | undefined,
): ReadonlySet<string> | null {
  return isObject(identity) ? (readers.get(identity)?.projects ?? null) : null;
}
export function readOnlyInviteOf(
  identity: CallerIdentity | undefined,
): string | null {
  return isObject(identity) ? (readers.get(identity)?.inviteId ?? null) : null;
}

export const callerProvenance = Object.freeze({
  human: humans.add.bind(humans),
  machine: machines.add.bind(machines),
  worker: workers.add.bind(workers),
  guest: guests.add.bind(guests),
  service: services.add.bind(services),
  reader: (value: HumanIdentity, mark: ReaderMark) => {
    humans.add(value);
    readers.set(value, mark);
  },
});
