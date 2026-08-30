import type { ProviderAuth } from "../../services/provider-auth/index.ts";
import type { Storage, Transaction } from "../../services/storage/index.ts";

export type CancelProviderLoginDependencies = Readonly<{
  storage: Storage;
  providerAuth: ProviderAuth;
}>;

export type CancelProviderLoginInput = Readonly<{ loginId: string }>;
export type CancelProviderLoginRefusal = "not-found";

export class CancelProviderLoginError extends Error {
  readonly refusal: CancelProviderLoginRefusal;

  constructor(refusal: CancelProviderLoginRefusal, message: string) {
    super(message);
    this.name = "CancelProviderLoginError";
    this.refusal = refusal;
  }
}

type CancelOutcome =
  Readonly<{ kind: "not-found" }> | Readonly<{ kind: "cancelled" }>;

export async function cancelProviderLogin(
  dependencies: CancelProviderLoginDependencies,
  input: CancelProviderLoginInput,
): Promise<void> {
  const outcome = dependencies.storage.transact<CancelOutcome>(
    (transaction: Transaction): CancelOutcome => {
      const selected = transaction.get(
        "SELECT id FROM provider_login WHERE id = ?",
        [input.loginId],
      );
      if (selected === undefined) return { kind: "not-found" };
      transaction.run("DELETE FROM provider_login WHERE id = ?", [
        input.loginId,
      ]);
      return { kind: "cancelled" };
    },
  );
  if (outcome.kind === "not-found") {
    throw new CancelProviderLoginError(
      "not-found",
      `no provider login ${input.loginId}`,
    );
  }
  dependencies.providerAuth.abortLogin(input.loginId);
}
