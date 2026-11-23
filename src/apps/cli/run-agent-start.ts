import { Diagnostic } from "../../kernel/errors.ts";

const ENV_PROXY = "cli.run.agent.env_proxy";
const NODE_USE_ENV_PROXY = "NODE_USE_ENV_PROXY";
const NODE_OPTIONS = "NODE_OPTIONS";
const USE_ENV_PROXY_FLAG = "--use-env-proxy";

function isUseEnvProxy(token: string): boolean {
  const option = token.replaceAll('"', "");
  return (
    option === USE_ENV_PROXY_FLAG || option.startsWith(`${USE_ENV_PROXY_FLAG}=`)
  );
}

export function checkProxySettings(
  env: NodeJS.ProcessEnv,
  execArgv: readonly string[],
): void {
  if (env[NODE_USE_ENV_PROXY] !== undefined)
    throw new Diagnostic(
      ENV_PROXY,
      "run agent: NODE_USE_ENV_PROXY is set; a Node proxy setting would reach model requests.",
      { fields: [["variables", NODE_USE_ENV_PROXY]] },
    );
  if (env[NODE_OPTIONS]?.split(/\s+/).some(isUseEnvProxy))
    throw new Diagnostic(
      ENV_PROXY,
      "run agent: NODE_OPTIONS holds --use-env-proxy; a Node proxy setting would reach model requests.",
      { fields: [["variables", NODE_OPTIONS]] },
    );
  if (execArgv.some(isUseEnvProxy))
    throw new Diagnostic(
      ENV_PROXY,
      "run agent: --use-env-proxy is in process.execArgv; a Node proxy setting would reach model requests.",
      { fields: [["option", USE_ENV_PROXY_FLAG]] },
    );
}
