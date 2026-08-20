import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { compareRouteSets, registryRows } from "./parity.ts";
import type { ParityRow } from "./parity.ts";
import { registry } from "./registry.ts";
import { readRouteMatrix } from "../../../test/helpers/proposal.ts";

const proposalRows = readRouteMatrix();

describe("src/http/contract/parity.test", () => {
  it("matches the routed and stubbed matrix exactly", () => {
    const comparable = proposalRows.filter(
      (row) => row.status === "routed" || row.status === "stubbed",
    );
    assert.equal(comparable.length, 70);
    assert.deepEqual(compareRouteSets(registryRows(registry), comparable), {
      missingFromRegistry: [],
      missingFromProposal: [],
      mismatched: [],
    });
  });

  it("pins the four deferred rows", () => {
    assert.equal(proposalRows.length, 74);
    const deferred = proposalRows.filter((row) => row.status === "deferred");
    assert.deepEqual(deferred.map((row) => row.operationId).sort(), [
      "binding.e2e.project",
      "binding.provider.agent",
      "binding.provider.project",
      "event.stream",
    ]);
    assert.ok(
      deferred.every((row) => row.introducedIn === "post-mvp"),
      "every deferred row is post-mvp",
    );
  });

  it("flags a post-mvp row registered in the registry", () => {
    const postMvp: ParityRow = {
      operationId: "event.stream",
      method: "GET",
      path: "/v1/event/stream",
      introducedIn: "post-mvp",
      status: "routed",
    };
    const report = compareRouteSets(
      [...registryRows(registry), postMvp],
      proposalRows.filter(
        (row) => row.status === "routed" || row.status === "stubbed",
      ),
    );
    assert.deepEqual(report.missingFromProposal, ["event.stream"]);
  });

  it("flags a registry route absent from the proposal", () => {
    const invented: ParityRow = {
      operationId: "zzz.invented",
      method: "GET",
      path: "/v1/zzz",
      introducedIn: "phase-1",
      status: "routed",
    };
    const report = compareRouteSets(
      [...registryRows(registry), invented],
      proposalRows.filter(
        (row) => row.status === "routed" || row.status === "stubbed",
      ),
    );
    assert.deepEqual(report.missingFromProposal, ["zzz.invented"]);
  });

  it("flags a proposal route absent from the registry", () => {
    const declared: ParityRow = {
      operationId: "aaa.declared",
      method: "GET",
      path: "/v1/aaa",
      introducedIn: "phase-1",
      status: "routed",
    };
    const report = compareRouteSets(registryRows(registry), [
      ...proposalRows.filter(
        (row) => row.status === "routed" || row.status === "stubbed",
      ),
      declared,
    ]);
    assert.deepEqual(report.missingFromRegistry, ["aaa.declared"]);
  });

  it("reports a method drift", () => {
    const registryRow: ParityRow = {
      operationId: "drift.x",
      method: "GET",
      path: "/v1/x",
      introducedIn: "phase-1",
      status: "routed",
    };
    const proposalRow: ParityRow = { ...registryRow, method: "POST" };
    const report = compareRouteSets([registryRow], [proposalRow]);
    assert.deepEqual(report.mismatched, [
      "drift.x method: registry GET, proposal POST",
    ]);
  });

  it("reports a path drift", () => {
    const registryRow: ParityRow = {
      operationId: "drift.x",
      method: "GET",
      path: "/v1/x",
      introducedIn: "phase-1",
      status: "routed",
    };
    const proposalRow: ParityRow = { ...registryRow, path: "/v1/y" };
    const report = compareRouteSets([registryRow], [proposalRow]);
    assert.deepEqual(report.mismatched, [
      "drift.x path: registry /v1/x, proposal /v1/y",
    ]);
  });

  it("reports an introducedIn drift", () => {
    const registryRow: ParityRow = {
      operationId: "drift.x",
      method: "GET",
      path: "/v1/x",
      introducedIn: "phase-1",
      status: "routed",
    };
    const proposalRow: ParityRow = { ...registryRow, introducedIn: "phase-2" };
    const report = compareRouteSets([registryRow], [proposalRow]);
    assert.deepEqual(report.mismatched, [
      "drift.x introducedIn: registry phase-1, proposal phase-2",
    ]);
  });

  it("reports a status drift", () => {
    const registryRow: ParityRow = {
      operationId: "drift.x",
      method: "GET",
      path: "/v1/x",
      introducedIn: "phase-1",
      status: "routed",
    };
    const proposalRow: ParityRow = { ...registryRow, status: "stubbed" };
    const report = compareRouteSets([registryRow], [proposalRow]);
    assert.deepEqual(report.mismatched, [
      "drift.x status: registry routed, proposal stubbed",
    ]);
  });

  it("parses the system.health row verbatim", () => {
    assert.deepEqual(
      proposalRows.find((row) => row.operationId === "system.health"),
      {
        operationId: "system.health",
        method: "GET",
        path: "/v1/health",
        introducedIn: "phase-1",
        status: "routed",
        source: "new decision, dependency status, authenticated",
      },
    );
  });

  it("parses provider.remove as a DELETE on a parameter path", () => {
    const row = proposalRows.find(
      (entry) => entry.operationId === "provider.remove",
    );
    assert.equal(row?.method, "DELETE");
    assert.equal(row?.path, "/v1/provider/:id");
  });
});
