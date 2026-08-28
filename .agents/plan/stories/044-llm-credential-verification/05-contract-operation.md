# Story 5 — Contract operation declaration

Epic: `.agents/plan/epics/044-llm-credential-verification.md`
Depends on: Story 4

## Change

### `src/http/contract/credential.ts`

Add the following exports after `providerSetDefaultExamples` (before the `operations([...])` call):

```ts
export const providerVerifyResponse = z.strictObject({
  checkedAt: z.number(),
  model: z.string(),
  reachability: z.enum(["reachable", "unreachable"]),
  authentication: z.enum(["accepted", "rejected", "unknown"]),
  completed: z.boolean(),
  refusal: z
    .enum([
      "endpoint-unreachable",
      "credential-rejected",
      "model-unavailable",
      "quota-exceeded",
      "endpoint-rejected",
    ])
    .nullable(),
  detail: z.string().optional(),
});
```

Add examples:

```ts
export const providerVerifyExamples: OperationExamples = {
  request: undefined,
  success: {
    checkedAt: A,
    model: "gpt-4o",
    reachability: "reachable",
    authentication: "accepted",
    completed: true,
    refusal: null,
  },
  error: {
    error: {
      code: "not-found",
      message: `no provider provider_${U}`,
    },
  },
};
```

Inside the `operations([...])` call, add the following entry AFTER the existing
`provider.show` entry and BEFORE `repository.inspect` (or whatever operation follows):

```ts
{
  operationId: "provider.verify",
  method: "POST",
  path: [resource("provider"), parameter("provider"), action("verify")],
  introducedIn: "phase-1",
  status: "routed",
  allowedActors: ["human"],
  idempotency: "memory",
  replayable: [200],
  response: providerVerifyResponse,
  errors: { ...baselineErrors },
  examples: providerVerifyExamples,
},
```

No `request` schema (no request body for a POST with no payload — the operation is
identified entirely by the path parameter).

### `src/http/contract/credential.test.ts`

Add a `describe` block after the last existing `describe` for `provider.setDefault`:

```ts
describe("providerVerifyResponse", () => {
  it("parses a success verdict", () => {
    const input = {
      checkedAt: A,
      model: "gpt-4o",
      reachability: "reachable",
      authentication: "accepted",
      completed: true,
      refusal: null,
    };
    assert.deepEqual(providerVerifyResponse.parse(input), input);
  });

  it("parses a verdict with detail", () => {
    const input = {
      checkedAt: A,
      model: "gpt-4o",
      reachability: "reachable",
      authentication: "rejected",
      completed: false,
      refusal: "credential-rejected",
      detail: "HTTP 401",
    };
    assert.deepEqual(providerVerifyResponse.parse(input), input);
  });

  it("rejects extra keys", () => {
    assert.throws(() =>
      providerVerifyResponse.parse({ ...validSuccessBody, extra: true }),
    );
  });

  it("rejects an unknown refusal string", () => {
    assert.throws(() =>
      providerVerifyResponse.parse({
        ...validSuccessBody,
        refusal: "invented-refusal",
      }),
    );
  });
});
```

Where `validSuccessBody` is:

```ts
const validSuccessBody = {
  checkedAt: A,
  model: "gpt-4o",
  reachability: "reachable" as const,
  authentication: "accepted" as const,
  completed: true,
  refusal: null,
};
```

Add the import of `providerVerifyResponse` to the import block.

### `src/http/contract/registry.test.ts`

The registry test verifies `registryFaults(registry)` returns `[]` and may assert
operation counts. Adding `"provider.verify"` changes these counts. Update every
numeric assertion that covers total operations, routed operations, phase-1 operations,
POST operations, or memory-idempotency operations:

| Counter            | Before → After                                                              |
| ------------------ | --------------------------------------------------------------------------- |
| total operations   | 69 → 70                                                                     |
| routed             | 44 → 45                                                                     |
| phase-1            | 39 → 40                                                                     |
| POST + body        | check and +1 if POST operations are counted (verify.ts has no request body) |
| memory idempotency | 28 → 29                                                                     |

The registry test has no operation fixture map — that map lives in `src/main.test.ts`.
The registry test only validates schema/fault rules. No fixture map edit in this file.

## Constraints

- `providerVerifyResponse` uses `z.strictObject` (no extra keys allowed).
- `refusal` is a `z.enum([...]).nullable()` — the enum values are exactly the five
  strings from `VerifyRefusal` in `src/services/provider-auth/index.ts`.
- `introducedIn: "phase-1"` (matching the decision in the EPIC).
- `idempotency: "memory"` requires `replayable: [200]`.
- No `request` schema is needed since the operation has no body (the provider id is
  in the path parameter).

## Verify

```
node --test src/http/contract/credential.test.ts src/http/contract/registry.test.ts
npm run lint -- --quiet
```

Proof: delivers `src/http/contract/credential.test.ts` and
`src/http/contract/registry.test.ts` (PASS EPIC-044).
