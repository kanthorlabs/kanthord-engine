import assert from "node:assert/strict";
import test from "node:test";
import { sshPortOf } from "./platform.ts";

const DEFAULT_PORT = 22;
const ALTERNATIVE_PORT = 443;

test("the port table maps each alternative SSH host to port 443 and every other host to port 22", () => {
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
