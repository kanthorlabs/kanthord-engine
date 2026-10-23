export interface ProbeCommand {
  readonly argv: readonly string[];
}

export interface ProbeAnswer {
  readonly image: string | null;
  readonly exit_code: number | null;
  readonly output: string;
}

export interface EnvironmentProbeRunner {
  run(input: {
    tags: readonly string[];
    checkout: string;
    command: ProbeCommand;
    signal: AbortSignal;
  }): Promise<ProbeAnswer>;
}
