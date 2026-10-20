import assert from "node:assert/strict";
import { test } from "node:test";
import { Diagnostic } from "../../kernel/errors.ts";
import { isPrivateAddress, refuseInsecureEndpoint } from "./endpoint-check.ts";

const ENDPOINT_INSECURE = "worker.start.endpoint_insecure";
const IPV4 = 4;

test("the private address set holds loopback, private, shared and local ranges", () => {
  for (const address of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "100.64.0.1",
    "::1",
    "fd00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
  ])
    assert.equal(isPrivateAddress(address), true, address);
  for (const address of ["8.8.8.8", "172.32.0.1", "100.128.0.1", "2001:db8::1"])
    assert.equal(isPrivateAddress(address), false, address);
});

test("an https endpoint passes and an http endpoint must resolve only to private addresses", async () => {
  await refuseInsecureEndpoint("https://kanthord.example", async () => {
    throw new Error("unexpected lookup");
  });
  await refuseInsecureEndpoint("http://127.0.0.1:31415");
  await refuseInsecureEndpoint("http://[::1]:31415");
  await refuseInsecureEndpoint("http://kanthord:31415", async () => [
    { address: "10.0.0.2", family: IPV4 },
  ]);
  for (const lookup of [
    async () => [{ address: "203.0.113.1", family: IPV4 }],
    async () => [
      { address: "10.0.0.2", family: IPV4 },
      { address: "203.0.113.1", family: IPV4 },
    ],
    async () => {
      throw new Error("ENOTFOUND");
    },
  ])
    await assert.rejects(
      refuseInsecureEndpoint("http://kanthord.example", lookup),
      (error: unknown) =>
        error instanceof Diagnostic && error.code === ENDPOINT_INSECURE,
    );
});
