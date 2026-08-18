import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RunnerError } from "../errors.ts";
import { secrets } from "../redact.ts";
import { pollHealth } from "../podman/readiness.ts";
import type { CommandRecord } from "../command.ts";
import type { BundleIdentity } from "../bundle.ts";
import type { ScenarioContext } from "../scenario/context.ts";
import type { OriginProbeInput, ProbeRow } from "./origin-probe.ts";
import type {
  DaemonConfig,
  DaemonHandle,
  ExecutionDriver,
  HostRole,
  HttpIssuer,
} from "./index.ts";

export type SshTarget = Readonly<{ role: HostRole; host: string }>;

export type SshExecutor = (
  target: SshTarget,
  argv: readonly string[],
  stdin?: string,
) => Promise<CommandRecord>;

export type SshDriverContext = Readonly<{
  daemonHost: string;
  clientHost: string;
  execute: SshExecutor;
}>;

function sshArgv(host: string, argv: readonly string[]): string[] {
  return [
    "ssh",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    host,
    "--",
    ...argv,
  ];
}

export async function createSshDriver(
  context: ScenarioContext,
  ssh: SshDriverContext,
): Promise<ExecutionDriver> {
  const daemonTarget: SshTarget = { role: "daemon", host: ssh.daemonHost };
  const clientTarget: SshTarget = { role: "client", host: ssh.clientHost };
  const localTarget: SshTarget = { role: "client", host: "local" };
  const home = `~/.kanthord-e2e-${context.tag}`;
  const tokenDirectory = `${home}/tokens`;
  const tokenCounters: Record<HostRole, number> = {
    daemon: 0,
    client: 0,
    client2: 0,
  };

  let memoizedTarball: Promise<string> | undefined;
  let baseUrl = "";
  let clientTokenPath = "";

  function targetFor(role: HostRole): SshTarget {
    switch (role) {
      case "daemon":
        return daemonTarget;
      case "client":
      case "client2":
        return clientTarget;
    }
  }

  function nextTokenFile(role: HostRole): string {
    tokenCounters[role] += 1;
    return `${tokenDirectory}/${role}-${String(tokenCounters[role])}`;
  }

  function parseActorId(record: CommandRecord): string {
    if (record.exitCode !== 0) {
      throw new RunnerError(
        "unavailable",
        `actor registration exited with code ${String(record.exitCode)}`,
      );
    }
    const actorId = record.stdout.split(/\r?\n/u)[0]?.trim() ?? "";
    if (actorId.length === 0) {
      throw new RunnerError(
        "assertion-failed",
        "actor registration returned no actor id",
      );
    }
    return actorId;
  }

  async function packLocally(): Promise<string> {
    if (memoizedTarball === undefined) {
      memoizedTarball = (async () => {
        const destination = tmpdir();
        await ssh.execute(localTarget, [
          "npm",
          "pack",
          "--pack-destination",
          destination,
        ]);
        const packageJson = JSON.parse(
          await readFile(join(process.cwd(), "package.json"), "utf8"),
        ) as Readonly<{ version: string }>;
        return join(destination, `kanthord-${packageJson.version}.tgz`);
      })();
    }
    return memoizedTarball;
  }

  async function writeRemoteSecret(
    target: SshTarget,
    path: string,
    value: string,
  ): Promise<void> {
    await ssh.execute(
      target,
      sshArgv(target.host, ["install", "-m", "600", "/dev/null", path]),
    );
    await ssh.execute(
      target,
      sshArgv(target.host, ["sh", "-c", `cat > ${path}`]),
      value,
    );
    secrets.hold(value);
    context.take({
      kind: "secret",
      id: `${target.host}:${path}`,
      async release(): Promise<void> {
        await ssh.execute(target, sshArgv(target.host, ["rm", "-f", path]));
      },
    });
  }

  async function identity(role: HostRole): Promise<BundleIdentity> {
    const target = targetFor(role);
    const script =
      "console.log(JSON.stringify({hostname:require('os').hostname(),platform:process.platform,architecture:process.arch}))";
    const record = await ssh.execute(
      target,
      sshArgv(target.host, ["node", "-e", script]),
    );
    return JSON.parse(record.stdout) as BundleIdentity;
  }

  async function deliverBinary(role: HostRole): Promise<string> {
    const target = targetFor(role);
    const tarball = await packLocally();
    const remoteTarball = `${home}.tgz`;

    await ssh.execute(target, [
      "scp",
      "-o",
      "BatchMode=yes",
      tarball,
      `${target.host}:${remoteTarball}`,
    ]);
    await ssh.execute(
      target,
      sshArgv(target.host, [
        "npm",
        "install",
        "--global",
        "--prefix",
        home,
        remoteTarball,
      ]),
    );

    context.take({
      kind: "directory",
      id: `${target.host}:${home}`,
      async release(): Promise<void> {
        await ssh.execute(target, sshArgv(target.host, ["rm", "-fr", home]));
      },
    });

    return `${home}/bin/kanthord`;
  }

  async function deliverDirectory(
    role: HostRole,
    source: string,
    name: string,
  ): Promise<string> {
    const target = targetFor(role);
    const destination = `${home}/${name}`;

    await ssh.execute(target, [
      "scp",
      "-o",
      "BatchMode=yes",
      "-r",
      source,
      `${target.host}:${destination}`,
    ]);

    context.take({
      kind: "directory",
      id: `${target.host}:${destination}`,
      async release(): Promise<void> {
        await ssh.execute(
          target,
          sshArgv(target.host, ["rm", "-fr", destination]),
        );
      },
    });

    return destination;
  }

  async function retrieveDirectory(
    role: HostRole,
    source: string,
    destination: string,
  ): Promise<void> {
    const target = targetFor(role);
    await ssh.execute(target, [
      "scp",
      "-o",
      "BatchMode=yes",
      "-r",
      `${target.host}:${source}`,
      destination,
    ]);
  }

  async function deliverToken(token: string): Promise<string> {
    const path = `${home}/token`;
    clientTokenPath = path;
    for (const target of [daemonTarget, clientTarget]) {
      await writeRemoteSecret(target, path, token);
    }
    return path;
  }

  async function probeOrigin(
    _input: OriginProbeInput,
  ): Promise<readonly ProbeRow[]> {
    throw new RunnerError(
      "unavailable",
      "the ssh driver runs the real profile and probes no fixture origin",
    );
  }

  async function deliverConfig(config: DaemonConfig): Promise<string> {
    const target = daemonTarget;
    const masterKeyPath = `${home}/master-key`;
    await writeRemoteSecret(target, masterKeyPath, config.masterKey);

    const tokenFilePath =
      config.http.token.length > 0 ? await deliverToken(config.http.token) : "";

    const settings = {
      home,
      actor: config.actor,
      http: {
        bind: config.http.bind,
        port: config.http.port,
        tokenFile: tokenFilePath,
        allowedHosts: config.http.allowedHosts,
      },
      masterKeyFile: masterKeyPath,
      tools: config.tools,
      attemptLimit: config.attemptLimit,
      leaseTtlMs: config.leaseTtlMs,
    };

    const configPath = `${home}/kanthord.config.json`;
    await ssh.execute(
      target,
      sshArgv(target.host, ["install", "-m", "600", "/dev/null", configPath]),
    );
    await ssh.execute(
      target,
      sshArgv(target.host, ["sh", "-c", `cat > ${configPath}`]),
      JSON.stringify(settings),
    );

    context.take({
      kind: "file",
      id: `${target.host}:${configPath}`,
      async release(): Promise<void> {
        await ssh.execute(
          target,
          sshArgv(target.host, ["rm", "-f", configPath]),
        );
      },
    });

    return configPath;
  }

  async function assertBareMachine(): Promise<void> {
    const target = daemonTarget;
    const record = await ssh.execute(
      target,
      sshArgv(target.host, ["test", "-e", "/etc/kanthord/config.json"]),
    );
    if (record.exitCode === 0) {
      throw new RunnerError(
        "unavailable",
        `/etc/kanthord/config.json exists on ${target.host}; P3-E6 needs a bare machine`,
      );
    }
  }

  const issueScript =
    "const fs=require('node:fs');const http=require('node:http');const chunks=[];" +
    "process.stdin.on('data',c=>chunks.push(c));" +
    "process.stdin.on('end',()=>{const req=JSON.parse(Buffer.concat(chunks).toString('utf8'));" +
    "const url=new URL(req.path,req.baseUrl);const headers={...req.headers};" +
    "if(req.tokenFile!==undefined)headers.Authorization='Bearer '+fs.readFileSync(req.tokenFile,'utf8').replace(/\\r?\\n$/,'');" +
    "const outgoing=http.request({method:req.method,hostname:url.hostname,port:url.port,path:url.pathname+url.search,headers},(res)=>{" +
    "const body=[];res.on('data',d=>body.push(d));res.on('end',()=>{process.stdout.write(res.statusCode+'\\n'+Buffer.concat(body).toString('utf8'));});});" +
    "outgoing.on('error',()=>process.stdout.write('0\\n'));" +
    "if(req.body!==undefined)outgoing.write(req.body);outgoing.end();});";

  async function issueAs(role: HostRole, input: Parameters<HttpIssuer>[0]) {
    const target = targetFor(role);
    const record = await ssh.execute(
      target,
      sshArgv(target.host, ["node", "-e", issueScript]),
      JSON.stringify({ ...input, baseUrl }),
    );

    const separatorIndex = record.stdout.indexOf("\n");
    const statusText =
      separatorIndex === -1
        ? record.stdout
        : record.stdout.slice(0, separatorIndex);
    const body =
      separatorIndex === -1 ? "" : record.stdout.slice(separatorIndex + 1);

    return { status: Number.parseInt(statusText, 10), body };
  }

  const issue: HttpIssuer = (input) => issueAs("client", input);

  async function daemonNetwork(): Promise<
    Readonly<{ bind: string; port: number; allowedHosts: readonly string[] }>
  > {
    const port = 7421;
    return {
      bind: "0.0.0.0",
      port,
      allowedHosts: [`${ssh.daemonHost}:${String(port)}`],
    };
  }

  async function startDaemon(config: DaemonConfig): Promise<DaemonHandle> {
    const target = daemonTarget;
    const binary = await deliverBinary("daemon");
    await deliverConfig(config);
    const logPath = `${home}/daemon.log`;
    baseUrl = `http://${config.http.bind}:${String(config.http.port)}`;

    await ssh.execute(
      target,
      sshArgv(target.host, [
        "sh",
        "-c",
        `HOME=${home} nohup ${binary} serve > ${logPath} 2>&1 < /dev/null &`,
      ]),
    );

    await pollHealth(issue, {
      token: config.http.token,
      allowedHost: config.http.allowedHosts[0] ?? "",
    });

    context.take({
      kind: "process",
      id: `${target.host}:kanthord-serve`,
      async release(): Promise<void> {
        await ssh.execute(
          target,
          sshArgv(target.host, ["pkill", "-TERM", "-f", `${binary} serve`]),
        );
      },
    });

    return {
      baseUrl,
      allowedHost: config.http.allowedHosts[0] ?? "",
      async ready(): Promise<void> {},
      async stop(): Promise<void> {
        await ssh.execute(
          target,
          sshArgv(target.host, ["pkill", "-TERM", "-f", `${binary} serve`]),
        );
      },
      async logs(): Promise<Readonly<{ stdout: string; stderr: string }>> {
        const record = await ssh.execute(
          target,
          sshArgv(target.host, ["cat", logPath]),
        );
        return { stdout: record.stdout, stderr: "" };
      },
    };
  }

  async function startDaemonExpectingRefusal(
    config: DaemonConfig | null,
  ): Promise<CommandRecord> {
    const target = daemonTarget;
    const binary = await deliverBinary("daemon");
    if (config !== null) {
      await deliverConfig(config);
    }

    return ssh.execute(
      target,
      sshArgv(target.host, ["env", `HOME=${home}`, binary, "serve"]),
    );
  }

  async function collectLogs(): Promise<Readonly<Record<string, string>>> {
    const target = daemonTarget;
    const logPath = `${home}/daemon.log`;
    const record = await ssh.execute(
      target,
      sshArgv(target.host, ["cat", logPath]),
    );
    return { daemon: record.stdout };
  }

  async function cliAs(
    role: HostRole,
    argv: readonly string[],
    options?: Readonly<{ tokenFile?: string }>,
  ): Promise<CommandRecord> {
    const environment: string[] = [];
    if (baseUrl.length > 0) {
      environment.push(`KANTHORD_BASE_URL=${baseUrl}`);
    }
    if (options?.tokenFile === undefined && clientTokenPath.length > 0) {
      environment.push(`KANTHORD_API_TOKEN_FILE=${clientTokenPath}`);
    }
    const authArgs =
      options?.tokenFile === undefined
        ? []
        : ["--api-token-file", options.tokenFile];
    return ssh.execute(targetFor(role), [
      ...(environment.length > 0 ? ["env", ...environment] : []),
      ...authArgs,
      ...argv,
    ]);
  }

  async function registerActor(
    role: HostRole,
    name: string,
  ): Promise<Readonly<{ actorId: string; tokenFile: string }>> {
    const tokenFile = nextTokenFile(role);
    const target = targetFor(role);
    await ssh.execute(
      target,
      sshArgv(target.host, ["mkdir", "-p", tokenDirectory]),
    );
    context.take({
      kind: "secret",
      id: `${target.host}:${tokenFile}`,
      async release(): Promise<void> {
        await ssh.execute(
          target,
          sshArgv(target.host, ["rm", "-f", tokenFile]),
        );
      },
    });
    const record = await cliAs(role, [
      "actor",
      "register",
      "--name",
      name,
      "--token-file",
      tokenFile,
    ]);
    return { actorId: parseActorId(record), tokenFile };
  }

  return {
    name: "ssh",
    identity,
    deliverBinary,
    deliverDirectory,
    retrieveDirectory,
    deliverConfig,
    deliverToken,
    probeOrigin,
    assertBareMachine,
    cliAs,
    async cli(argv: readonly string[]): Promise<CommandRecord> {
      return cliAs("client", argv);
    },
    issueAs,
    registerActor,
    async issue(input) {
      return issueAs("client", input);
    },
    daemonNetwork,
    startDaemon,
    startDaemonExpectingRefusal,
    collectLogs,
  };
}
