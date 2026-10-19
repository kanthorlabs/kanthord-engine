import assert from "node:assert/strict";
import test from "node:test";
import { sshKnownHostsName, sshPortOf } from "./platform.ts";

const DEFAULT_PORT = 22;
const ALTERNATIVE_PORT = 443;
const GITLAB = "gitlab.com";
const GITHUB = "github.com";
const SSH_GITHUB = "ssh.github.com";
const ALTSSH_GITLAB = "altssh.gitlab.com";
const ALTSSH_BITBUCKET = "altssh.bitbucket.org";

test("the port table maps ssh.github.com and each alternative SSH host to port 443 and every other host to port 22", () => {
  const ports = {
    "github.com": DEFAULT_PORT,
    "ssh.github.com": ALTERNATIVE_PORT,
    "SSH.GitHub.COM": ALTERNATIVE_PORT,
    "gitlab.com": DEFAULT_PORT,
    "bitbucket.org": DEFAULT_PORT,
    "altssh.gitlab.com": ALTERNATIVE_PORT,
    "altssh.bitbucket.org": ALTERNATIVE_PORT,
    "AltSSH.GitLab.COM": ALTERNATIVE_PORT,
  };
  for (const [host, port] of Object.entries(ports))
    assert.equal(sshPortOf(host), port, host);
});

test("the known_hosts name of a host keeps the bare name on port 22 and takes the bracket form on another port", () => {
  const names = {
    [GITLAB]: GITLAB,
    "GitHub.COM": GITHUB,
    [SSH_GITHUB]: `[${SSH_GITHUB}]:${ALTERNATIVE_PORT}`,
    [ALTSSH_GITLAB]: `[${ALTSSH_GITLAB}]:${ALTERNATIVE_PORT}`,
    [ALTSSH_BITBUCKET]: `[${ALTSSH_BITBUCKET}]:${ALTERNATIVE_PORT}`,
  };
  for (const [host, name] of Object.entries(names))
    assert.equal(sshKnownHostsName(host), name, host);
});
