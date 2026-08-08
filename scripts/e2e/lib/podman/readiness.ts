import { RunnerError } from "../errors.ts";
import type { HttpIssuer } from "../driver/index.ts";

export const readinessDeadlineMilliseconds = 30000;
export const readinessIntervalMilliseconds = 250;

export function withDeadline<T>(
  run: (resolve: (value: T) => void, reject: (reason: unknown) => void) => void,
  milliseconds: number,
  onTimeout: () => Error,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(onTimeout());
      }
    }, milliseconds);

    run(
      (value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }
      },
      (reason) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(reason);
        }
      },
    );
  });
}

export async function pollHealth(
  issue: HttpIssuer,
  target: Readonly<{ token: string; allowedHost: string }>,
): Promise<void> {
  const deadline = Date.now() + readinessDeadlineMilliseconds;
  let lastStatus = 0;
  let lastBody = "";
  let lastError: unknown;

  return new Promise<void>((resolve, reject) => {
    const bail = (): void => {
      const error = new RunnerError(
        "assertion-failed",
        `the daemon was not healthy within ${readinessDeadlineMilliseconds}ms`,
      );
      reject(Object.assign(error, { lastStatus, lastBody, lastError }));
    };

    const attempt = (): void => {
      issue({
        method: "GET",
        path: "/v1/health",
        headers: {
          Authorization: `Bearer ${target.token}`,
          Host: target.allowedHost,
        },
        omitHost: false,
      })
        .then((response) => {
          lastStatus = response.status;
          lastBody = response.body;

          if (response.status === 200) {
            resolve();
            return;
          }

          if (Date.now() >= deadline) {
            bail();
            return;
          }

          setTimeout(attempt, readinessIntervalMilliseconds);
        })
        .catch((error: unknown) => {
          lastError = error;

          if (Date.now() >= deadline) {
            bail();
            return;
          }

          setTimeout(attempt, readinessIntervalMilliseconds);
        });
    };

    attempt();
  });
}
