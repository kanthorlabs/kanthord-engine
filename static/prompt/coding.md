## Code principles

These rules bind every code change.

1. **Simplicity in code.** Omit no validation, no test and no clarity to reduce the line count. Add no abstraction for single-use code, no speculative flexibility and no speculative error handling.
2. **Surgical code changes.** Improve no adjacent code or comment. Match the existing code style, even when another style is better. Remove only the orphans that the change created. Do not delete unrelated dead code: mention it.
3. **Prefer the built-ins of the platform.** Reach for the standard library and the native API before a new dependency. Hand-roll no fragile code to avoid an import. When an external library is the hardened, idiomatic choice of the ecosystem for a complex task, use it.
4. **One responsibility per component.** Keep concerns separate. Fold no unrelated logic into one module or one function to save a file. Match the granularity of the codebase. Split no further than the codebase does.
5. **Code comments are forbidden.** Names, structure and types make the behaviour evident. Only a human adds a logic comment.
6. **No leftover.** Remove debug output before completion. Leave no file that the task does not need.

## Code

1. **Linear control flow.** Keep the control flow linear. Nest at most two control-flow levels. Prefer a guard clause and an early return.
2. **Bounded loops.** When the end of a loop depends on input that the code does not own, give the loop an explicit bound. Give every retry an attempt limit and a timeout. Give every service loop an explicit shutdown path. Add no bound to a loop over a collection that the code holds.
3. **Resource ownership.** Give every resource one explicit owner. Release the resource on success, on error and on cancellation. Use the construct of the language that guarantees the release: a context manager, `defer`, `finally` or RAII.
4. **Small functions.** Give each function one job. Match the function size of the codebase.
5. **Assertions.** Assert an internal invariant where a wrong value causes silent damage. Keep an assertion free of side effects. Validate an external input with an explicit error. Add no assertion that restates a type or a constant.
6. **Explicit errors.** Handle or propagate every error. Catch an error only where the scope recovers fully and keeps correctness. Add context to the error when it helps. Hide no failure behind a `null`, an empty list, a `false`, a log line or a best-effort path. Let a parse error propagate. When an entrypoint translates an error, preserve the failure signal. Add no catch to satisfy a lint rule.
7. **Zero warnings.** The compiler, type, lint and static-analysis checks of the codebase report zero warnings and zero errors. Fix the cause of a warning. Suppress no warning.
8. **No test knowledge in production code.** Add no branch on a test flag or a test environment variable. Make no fake reachable from production code. Add no export that exists only for a test assertion.

## Tests

1. **Bounded waits.** Give every test that waits for an event, a process or a request its own timeout.
2. **No self-spawning test.** Never spawn the test runner on the test file that holds the spawning test.
