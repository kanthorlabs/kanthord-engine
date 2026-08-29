# Story 5 — The auth service drives a suspended login

Epic: `.agents/plan/epics/045-subscription-authentication-for-llm-providers.md`
Depends on: Story 4 (`chooseOptionId`, `LoginError`, the interface member).

`login()` takes exactly one argument, a `ProviderAuthInteraction` whose `signal` is
required. There is no second signal parameter. `notify` is synchronous and returns `void`,
so it suspends nothing; the only awaitable suspension the library offers is a `prompt`.

## Change

### `src/services/provider-auth/index.ts`

Append:

```ts
export const DEFAULT_POLL_INTERVAL_MS = 5_000;
export const DEFAULT_EXPIRES_IN_SECONDS = 600;

export type LoginChallenge =
  | Readonly<{
      method: "manual-code";
      authUrl: string;
      instructions: string;
      expiresAt: number | null;
    }>
  | Readonly<{
      method: "device-code";
      userCode: string;
      verificationUri: string;
      pollIntervalMs: number;
      expiresAt: number;
    }>;

export type StartLoginInput = Readonly<{
  loginId: string;
  vendorId: string;
  answers: Readonly<Record<string, string>>;
}>;

export type CompleteLoginInput = Readonly<{
  loginId: string;
  code?: string;
}>;

export type CompletedLogin = Readonly<{
  credential: Readonly<Record<string, unknown>>;
  availableModelIds: readonly string[] | null;
}>;

export type CompleteLoginOutcome =
  | Readonly<{ status: "completed"; login: CompletedLogin }>
  | Readonly<{ status: "pending" }>
  | Readonly<{ status: "lost" }>;

export type LoginRefusal =
  | "provider-not-oauth-capable"
  | "login-method-unavailable"
  | "login-input-required"
  | "login-in-progress"
  | "code-required"
  | "login-failed";
```

Replace the `LoginRefusal` declared in Story 4 with this wider union. Extend the interface:

```ts
export interface ProviderAuth {
  probe(row: ProviderAuthRow, signal: AbortSignal): Promise<ProbeOutcome>;
  oauthVendors(): readonly OauthVendor[];
  startLogin(input: StartLoginInput): Promise<LoginChallenge>;
  completeLogin(input: CompleteLoginInput): Promise<CompleteLoginOutcome>;
  abortLogin(loginId: string): void;
}
```

`expiresAt` is `null` on the manual arm: nothing the vendor sends bounds it, so the
command applies the ten-minute rule. On the device arm the service computes it, because
only the service observes the moment the `device_code` event arrives.

### `src/services/provider-auth/pi-ai.ts`

Add a `Clock` dependency and a live-flow map to `PiAiProviderAuth`. Import `Clock` as a
type from `../clock/index.ts` — a service implementation may import another service
interface.

```ts
type LiveLogin = {
  readonly vendorId: string;
  readonly controller: AbortController;
  settled: Promise<OAuthCredential>;
  challenge?: LoginChallenge;
  manualCode?: {
    resolve: (code: string) => void;
    reject: (error: unknown) => void;
  };
  outcome: "running" | "resolved" | "rejected";
  credential?: OAuthCredential;
  failure?: unknown;
};
```

Hold them in `readonly #logins = new Map<string, LiveLogin>();`.

Add a constructor seam beside the existing `createModels` one
(`src/services/provider-auth/pi-ai.ts:62-65`), so a test injects a double instead of the
real library:

```ts
type PiAiProviderAuthDependencies = Readonly<{
  createTimeoutSignal: (milliseconds: number) => AbortSignal;
  createModels: typeof builtinModels;
  resolveOauth: (vendorId: string) => OAuthAuth | undefined;
  clock: Clock;
}>;
```

The default `resolveOauth` is
`(vendorId) => builtinProviders().find((p) => p.id === vendorId)?.auth.oauth`, and the
default `clock` is `{ now: () => Date.now() }`.

**`startLogin`.** One sequence, no branching beyond what is written:

0. **Claim the vendor synchronously, before any `await`.** Add
   `readonly #startingVendors = new Set<string>();` beside `#logins`, and open `startLogin`
   with:

   ```ts
   if (this.#startingVendors.has(input.vendorId)) {
     throw new LoginError(
       "login-in-progress",
       `a ${input.vendorId} login is already starting`,
     );
   }
   this.#startingVendors.add(input.vendorId);
   ```

   Add `"login-in-progress"` to `LoginRefusal`.

   **The claim is released on failure only, never on success.** Wrap the rest of the method
   so that every throwing path runs `this.#startingVendors.delete(input.vendorId)`, and a
   successful return leaves the claim held. A `finally` here would be a defect: `startLogin`
   returns while the flow is still live and _before_ the command's INSERT, so releasing at
   return reopens the very window this closes — a second caller could enter, find no claim
   and no row, and bind the port.

   On success the claim is owned by the live flow, and it is released in exactly the three
   places that delete the `#logins` entry: a completed `completeLogin`, a rejected flow
   observed by either method, and `abortLogin`. Keep the two collections in step — every
   `#logins.delete(loginId)` is paired with
   `#startingVendors.delete(live.vendorId)`. `LiveLogin` already carries `vendorId`, so no
   extra bookkeeping is needed.

   This is the **primary** guard against two concurrent logins for one vendor, and it must
   be the first statement in the method. The command's pending-row pre-check runs in a
   transaction that commits before the service call, so two callers can both read no pending
   row and both reach `login()`; the second then collides on `anthropic`'s fixed callback
   port (`dist/auth/oauth/anthropic.js:17,131` — `CALLBACK_PORT = 53692`) and fails with
   `EADDRINUSE` instead of the refusal we have for exactly this case. A row cannot be the
   lock, because `method` and the device arm's `expires_at` are unknown until the vendor
   answers.

   The claim is correct because it is **synchronous**: Node is single-threaded and the home
   lock guarantees one process, so no other caller can run between the `has` and the `add`.
   Do not make this an async mutex, and do not move the claim below the `resolveOauth`
   lookup — a rejected vendor releases the claim on its throwing path like any other failure.

   The partial unique index stays as the backstop for what this cannot see: a `pending` row
   left by a previous process, which no in-memory claim survives. Story 7 keeps its insert
   catch.

1. `const oauth = this.#resolveOauth(input.vendorId)`. If `undefined`, throw
   `new LoginError("provider-not-oauth-capable", \`${input.vendorId} has no oauth flow\`)`.
   Make no call of any kind first.
2. Build a `controller = new AbortController()` and two deferreds: `challengeReady` and
   `manualCode`.

   **Construct `live` before the interaction, and before `login()` is called.** A flow may
   call `prompt` or `notify` **synchronously**, before `oauth.login(...)` returns its
   promise — `github-copilot` prompts as its first statement — so a closure that reads
   `live` must find it already initialized. `settled` is therefore assigned after
   construction, not in the object literal:

   ```ts
   const live: LiveLogin = {
     vendorId: input.vendorId,
     controller,
     settled: undefined as unknown as Promise<OAuthCredential>,
     outcome: "running",
   };
   ```

   Declare `settled` as a mutable field on `LiveLogin` and assign it at step 4. Do not use a
   lazy getter, a placeholder promise or a second indirection; this two-step assignment is
   the whole design.

3. Build the interaction:

   ```ts
   const interaction = {
     signal: controller.signal,
     prompt: async (prompt: AuthPrompt): Promise<string> => {
       if (prompt.type === "select") {
         return chooseOptionId(input.vendorId, prompt.options.map((o) => o.id));
       }
       if (prompt.type === "text" || prompt.type === "secret") {
         const answer = input.answers[prompt.message];
         if (answer === undefined) {
           throw new LoginError(
             "login-input-required",
             `the ${input.vendorId} login needs an answer`,
             prompt.message,
           );
         }
         return answer;
       }
       live.manualCode = { resolve: …, reject: … };
       challengeReady.resolve();
       return manualCode.promise;
     },
     notify: (event: AuthEvent): void => {
       if (event.type === "auth_url") {
         live.challenge = {
           method: "manual-code",
           authUrl: event.url,
           instructions: event.instructions ?? "",
           expiresAt: null,
         };
         challengeReady.resolve();
         return;
       }
       if (event.type === "device_code") {
         live.challenge = {
           method: "device-code",
           userCode: event.userCode,
           verificationUri: event.verificationUri,
           pollIntervalMs:
             (event.intervalSeconds ?? DEFAULT_POLL_INTERVAL_MS / 1000) * 1000,
           expiresAt:
             this.#clock.now() +
             (event.expiresInSeconds ?? DEFAULT_EXPIRES_IN_SECONDS) * 1000,
         };
         challengeReady.resolve();
         return;
       }
     },
   };
   ```

   `progress` and `info` are ignored, and the handler has no `else`. A `manual_code`
   prompt is the fourth `AuthPrompt` variant and the only remaining case; it registers the
   resolver, resolves `challengeReady` (harmless if `auth_url` already did), and returns
   the deferred promise. That return is the suspension.

   `pollIntervalMs` is the event's `intervalSeconds` times one thousand, and exactly
   `DEFAULT_POLL_INTERVAL_MS` when the event omits it.

4. Start the flow **without awaiting it**, and record its settlement:

   ```ts
   const settled = oauth.login(interaction);
   settled.then(
     (credential) => {
       live.outcome = "resolved";
       live.credential = credential;
     },
     (failure) => {
       live.outcome = "rejected";
       live.failure = failure;
       challengeReady.reject(failure);
     },
   );
   ```

   Attach a no-op `.catch(() => {})` to `settled` as well, so a rejection that nobody
   awaits yet never becomes an unhandled rejection.

5. `await challengeReady.promise`, **raced against a start deadline**:

   ```ts
   const deadline = new Promise<never>((_, reject) =>
     setTimeout(
       () =>
         reject(new LoginError("login-failed", "the vendor did not answer")),
       START_TIMEOUT_MS,
     ).unref(),
   );
   await Promise.race([challengeReady.promise, deadline]);
   ```

   `export const START_TIMEOUT_MS = 30_000;` beside the other constants. Without it a vendor
   that hangs before its first event leaves a live flow the caller can never reach: the map
   entry is not written until step 6, so no `loginId` exists to cancel. The `.unref()` keeps
   the timer from holding the process open.

   On **any** failure of this race — a rejection or the deadline — `controller.abort()`
   first, then delete the map entry if one exists, then rethrow: a `LoginError` propagates
   as itself; anything else becomes `new LoginError("login-failed", message)`. The abort is
   mandatory: this is the one path where the flow is live and unreachable, so failing to
   abort leaks a callback server or a poll for the life of the process.

6. Store `live` in `#logins` under `input.loginId` and return `live.challenge`. If the flow
   resolved before any challenge was captured, still return the challenge if one exists;
   if none exists, throw `LoginError("login-failed", …)`.

**`completeLogin`.**

1. `const live = this.#logins.get(input.loginId)`. If `undefined`, return
   `{ status: "lost" }`. The service reports the fact; the command decides the refusal.
2. If `live.outcome === "rejected"`, delete the entry and throw the mapped `LoginError`.
3. If `live.outcome === "resolved"`, delete the entry and return
   `{ status: "completed", login: toCompleted(live.credential) }`. This is the case where
   the vendor callback won the race and no code was ever pasted.
4. Still running, device arm (`live.challenge.method === "device-code"`): return
   `{ status: "pending" }`. Never await the flow — the request must not block on the
   vendor.
5. Still running, manual arm: if `input.code === undefined`, throw
   `new LoginError("code-required", …)`. Otherwise
   `live.manualCode.resolve(input.code)`, `await live.settled`, delete the entry and
   return `{ status: "completed", … }`. A rejection maps to `LoginError("login-failed", …)`.

`toCompleted(credential)` returns
`{ credential, availableModelIds: readModelIds(credential) }` where `readModelIds`
narrows the untyped extra key, mirroring the library's own defensive read
(`dist/providers/github-copilot.js:18-27`):

```ts
function readModelIds(credential: OAuthCredential): readonly string[] | null {
  const value: unknown = credential["availableModelIds"];
  if (!Array.isArray(value)) return null;
  if (!value.every((id) => typeof id === "string")) return null;
  return value as readonly string[];
}
```

Only the `github-copilot` flow sets `availableModelIds`; every other vendor yields `null`.
This is verified against the installed library — see suggestion **S1** in the index.

**`abortLogin(loginId)`.** Look the entry up; if absent, return. Otherwise
`live.controller.abort()`, `live.manualCode?.reject(new LoginError("login-failed", "aborted"))`,
and delete the entry. It is idempotent and never throws. Aborting through the signal is
what lets `pi-ai` close its callback server or stop its poll.

### `src/services/provider-auth/pi-ai.test.ts`

Add `describe("the suspended login")`. Every case injects a double through `resolveOauth`
and a `createMockClock`. No case reaches a vendor.

Build one helper in the test file:

```ts
function fakeOauth(
  run: (interaction: ProviderAuthInteraction) => Promise<OAuthCredential>,
): OAuthAuth {
  return {
    name: "Fake",
    login: run,
    refresh: async (credential) => credential,
    toAuth: async () => ({ type: "api_key", key: "" }) as unknown as ModelAuth,
  };
}
```

Fixture credential:
`{ type: "oauth", access: "at-1", refresh: "rt-1", expires: 1_700_000_600_000 }`.

Tests:

1. `it("refuses a vendor with no oauth flow and makes no call")` — `resolveOauth` returns
   `undefined` and records that it was asked; assert `LoginError` with
   `refusal === "provider-not-oauth-capable"` and that the double's `login` was never
   called.
2. `it("answers a select with the device-code option")` — the double prompts a select with
   `["browser","device_code"]`, then notifies `device_code`; assert the answer the double
   received is `"device_code"`.
3. `it("refuses a select with no recognized option and prompts no further")` — the double
   prompts `["qr","sms"]`; assert `LoginError` with `refusal === "login-method-unavailable"`,
   `detail === "qr,sms"`, and that the double recorded exactly one prompt.
4. `it("answers a text prompt from answers")` — `answers` maps
   `"GitHub Enterprise URL/domain (blank for github.com)"` to `""`; assert the double
   received `""`.
5. `it("refuses a text prompt with no matching answer and carries the message")` — assert
   `LoginError`, `refusal === "login-input-required"`, and `detail` equal to the exact
   prompt message string.
6. `it("returns the device challenge with the event interval in milliseconds")` — the
   double notifies
   `{ type: "device_code", userCode: "WDJB-MJHT", verificationUri: "https://v.test/device", intervalSeconds: 7, expiresInSeconds: 300 }`
   with the mock clock at `1_700_000_000_000`; assert the challenge deep-equals
   `{ method: "device-code", userCode: "WDJB-MJHT", verificationUri: "https://v.test/device", pollIntervalMs: 7000, expiresAt: 1_700_000_300_000 }`.
7. `it("falls back to five seconds and ten minutes when the event omits them")` — the same
   event without `intervalSeconds` and `expiresInSeconds`; assert `pollIntervalMs === 5000`
   and `expiresAt === 1_700_000_600_000`.
8. `it("times the device expiry from the event, not from the start")` — the double awaits
   a text prompt first, and the mock clock advances two minutes between `startLogin` and
   the `device_code` notify; assert `expiresAt` equals the clock **at the event** plus
   `expiresInSeconds`, and assert it is not the start time plus `expiresInSeconds`. Use
   `createMockClock({ start: 1_700_000_000_000, step: 120_000 })`.
9. `it("returns the manual challenge from the auth_url event")` — the double notifies
   `{ type: "auth_url", url: "https://vendor.test/authorize?x=1", instructions: "Complete login in your browser." }`
   then awaits a `manual_code` prompt; assert the challenge deep-equals
   `{ method: "manual-code", authUrl: "https://vendor.test/authorize?x=1", instructions: "Complete login in your browser.", expiresAt: null }`
   and assert `startLogin` resolves while the double is still suspended.
10. `it("ignores progress and info events")` — the double notifies `progress` before
    `auth_url`; assert the challenge is unchanged.
11. `it("supplies the pasted code to the suspended manual prompt")` — after `startLogin`,
    call `completeLogin({ loginId, code: "abc-123" })`; assert the double received exactly
    `"abc-123"` and the outcome is `{ status: "completed", … }` carrying the fixture
    credential.
12. `it("completes a manual login the callback already resolved, with no code")` — the
    double resolves its `login()` promise without ever prompting `manual_code`, after
    notifying `auth_url`; call `completeLogin({ loginId })` with **no** `code`; assert
    status `"completed"`. This is the race the EPIC names.
13. `it("refuses an absent code on a still-suspended manual arm")` — assert `LoginError`
    with `refusal === "code-required"`, and assert the double stays suspended.
14. `it("answers pending while the device flow still polls")` — the double never resolves;
    assert `completeLogin({ loginId })` answers `{ status: "pending" }` and returns without
    awaiting the flow. Then resolve the double and assert the next `completeLogin` answers
    `"completed"`.
15. `it("answers lost for an unknown loginId")` — assert `{ status: "lost" }`.
16. `it("reads availableModelIds when the credential carries them")` — the double resolves
    with the fixture credential plus `availableModelIds: ["gpt-5-codex","gpt-5"]`; assert
    the outcome carries exactly that array.
17. `it("answers null model ids when the key is absent or malformed")` — three cases:
    absent, `"not-an-array"`, and `["a", 2]`; all yield `null`.
18. `it("aborts the live flow through its signal and forgets it")` — the double records
    `interaction.signal`; call `abortLogin(loginId)`; assert `signal.aborted === true`, that
    a following `completeLogin` answers `{ status: "lost" }`, and that a second
    `abortLogin` does not throw.
19. `it("propagates a login failure as login-failed")` — the double rejects with
    `new Error("vendor said no")`; assert `startLogin` throws `LoginError` with
    `refusal === "login-failed"`.
20. `it("does not leak the token into the LoginError message or detail")` — assert the
    serialized error contains neither `"at-1"` nor `"rt-1"`.
21. `it("answers a prompt issued synchronously before login returns")` — the double calls
    `interaction.prompt` **before** its first `await`, mirroring `github-copilot`; assert
    the answer arrives and no `TypeError` about an uninitialized binding is thrown. This is
    the regression guard for the two-step `live` construction.
22. `it("aborts the flow when the vendor answers nothing before the start deadline")` — the
    double never notifies and never prompts; drive it with an injected timer or a
    one-millisecond `START_TIMEOUT_MS` override; assert `LoginError` with
    `refusal === "login-failed"`, that the double's `interaction.signal.aborted` is `true`,
    and that the live map holds no entry.
23. `it("aborts the flow when startLogin fails before a challenge")` — the double rejects
    after recording its signal; assert `signal.aborted === true` and no map entry survives.

**Vendor-claim tests.** These are the regression guard for the concurrent-start race.

24. `it("refuses a second concurrent start for one vendor before calling the flow")` — the
    double suspends on a `manual_code` prompt and never resolves. Start login A and, without
    awaiting it, call `startLogin` again for the same vendor. Assert the second rejects with
    `LoginError` and `refusal === "login-in-progress"`, and assert the double's `login` was
    called **exactly once** — the second caller must never reach the flow, which is what
    keeps it off `anthropic`'s fixed port.
25. `it("admits a concurrent start for a different vendor")` — the same setup with a second
    vendor id; assert both succeed and `login` was called twice.
26. `it("holds the claim after startLogin returns")` — await a successful `startLogin`, then
    call `startLogin` again for that vendor and assert `login-in-progress`. This is the case
    a `finally`-released claim would wrongly admit, and it covers the window between
    `startLogin` returning and the command's INSERT.
27. `it("releases the claim when the flow fails")` — the double rejects; assert the first
    `startLogin` throws, then assert a second `startLogin` for the same vendor **succeeds**.
28. `it("releases the claim on abort")` — start, `abortLogin(loginId)`, then assert a new
    `startLogin` for that vendor succeeds.
29. `it("releases the claim when the login completes")` — start, `completeLogin` to success,
    then assert a new `startLogin` for that vendor succeeds.
30. `it("releases the claim for a vendor with no oauth flow")` — assert the
    `provider-not-oauth-capable` refusal, then assert a later `startLogin` for that same
    vendor id is not refused as `login-in-progress`.

## Constraints

- `startLogin` resolves as soon as a challenge exists. It never awaits the `login()`
  promise.
- `completeLogin` on the device arm never awaits the `login()` promise.
- The map entry is deleted on exactly three paths: a completed `completeLogin`, a rejected
  flow observed by either method, and `abortLogin`. Nothing else deletes it.
- `#startingVendors` is claimed **synchronously, as the first statement of `startLogin`**,
  released on every throwing path, and **not** released on success. Every
  `#logins.delete(loginId)` is paired with `#startingVendors.delete(live.vendorId)`; the two
  collections never drift.
- The claim is a plain `Set` and a synchronous check. No async mutex, no promise chain, no
  timer.
- `notify` stays synchronous and returns `void`.
- A `select` is answered only through `chooseOptionId`. No inline preference logic.
- The credential object is stored and returned as received, with every extra key intact.
- No token value appears in any `LoginError` message or `detail`.
- Attach a swallowing `.catch` to the `login()` promise so an early rejection cannot become
  an unhandled rejection and fail the test run.

## Verify

```
node --test src/services/provider-auth/pi-ai.test.ts
npm run verify
```

Asserts every case listed above by value, including both challenge shapes field by field,
the interval and expiry fallbacks by exact number, the event-timed device expiry proved by
a fixture that burns two minutes before the event, the callback-won race completing with no
code, `pending` then `completed` across two device calls, and the abort reaching the
double's own `AbortSignal`.

Proof: delivers `src/services/provider-auth/pi-ai.test.ts` (PASS EPIC-045).
`npm run verify` exits 0.
