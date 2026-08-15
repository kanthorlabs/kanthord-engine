export type ActorCommandRefusal =
  | "name-taken"
  | "no-configured-token"
  | "bootstrap-actor"
  | "actor-revoked"
  | "not-found";

export class ActorCommandError extends Error {
  readonly refusal: ActorCommandRefusal;

  constructor(refusal: ActorCommandRefusal, message: string) {
    super(message);
    this.name = "ActorCommandError";
    this.refusal = refusal;
  }
}
