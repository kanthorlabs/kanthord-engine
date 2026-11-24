const SIGINT = "SIGINT";
const SIGTERM = "SIGTERM";
const SHUTDOWN_LIMIT_MS = 10000;

export interface StopHandlers {
  release(): void;
  ignoreSignals(): void;
  setForceStop(fn: () => void): void;
  readonly forcedWithoutResult: boolean;
}

export function stopOnSignal(controller: AbortController): StopHandlers {
  let forceStopFn: (() => void) | null = null;
  let shutdownStarted = false;
  let ignoring = false;
  let shutdownTimer: ReturnType<typeof setTimeout> | null = null;
  let _forcedWithoutResult = false;

  const clearShutdownTimer = (): void => {
    if (shutdownTimer !== null) {
      clearTimeout(shutdownTimer);
      shutdownTimer = null;
    }
  };

  const removeHandlers = (): void => {
    process.off(SIGINT, onSignal);
    process.off(SIGTERM, onSignal);
  };

  const doForceStop = (noResult: boolean): void => {
    clearShutdownTimer();
    ignoring = true;
    if (noResult) _forcedWithoutResult = true;
    forceStopFn?.();
  };

  const onSignal = (): void => {
    if (ignoring) return;
    if (shutdownStarted) {
      doForceStop(true);
      return;
    }
    shutdownStarted = true;
    controller.abort();
    shutdownTimer = setTimeout(() => doForceStop(false), SHUTDOWN_LIMIT_MS);
  };

  process.on(SIGINT, onSignal);
  process.on(SIGTERM, onSignal);

  return {
    release(): void {
      clearShutdownTimer();
      removeHandlers();
    },
    ignoreSignals(): void {
      clearShutdownTimer();
      ignoring = true;
    },
    setForceStop(fn: () => void): void {
      forceStopFn = fn;
    },
    get forcedWithoutResult(): boolean {
      return _forcedWithoutResult;
    },
  };
}
