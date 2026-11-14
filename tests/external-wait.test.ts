import assert from "node:assert/strict";
import test from "node:test";
import { normalizeExternalWait, planExternalWait, type ExternalWait } from "../src/agent/external-wait.js";
import type { RepairCaseWake } from "../src/storage/repair-cases.js";

const now = new Date("2026-11-14T12:00:00.000Z");
const event: RepairCaseWake = { type: "arr_event", provider: "sonarr", eventType: "download", mediaIds: ["episode:42"] };
const release: ExternalWait = { reason: "release", availableAt: "2026-11-18T00:00:00Z", provider: "sonarr", eventType: "download", mediaIds: ["episode:42"] };

test("release waits delay both event fallbacks and timer-only checks until release plus grace", () => {
  for (const wake of [event, { type: "timer", dueAt: "2026-11-14T12:15:00Z" } as const]) {
    const plan = planExternalWait(release, wake, undefined, undefined, now);
    assert.equal(plan.state.nextCheckAt, "2026-11-18T01:00:00.000Z");
    assert.equal(plan.wake.type === "arr_event" ? plan.wake.fallbackAt : plan.wake.dueAt, plan.state.nextCheckAt);
    assert.equal(plan.quiet, false);
  }
});

test("unchanged checks back off to a daily cap and compare normalized state", () => {
  const wait: ExternalWait = { ...release, reason: "download", availableAt: undefined };
  let clock = now;
  let planned = planExternalWait(wait, event, undefined, undefined, clock);
  assert.equal(planned.state.nextCheckAt, "2026-11-14T14:00:00.000Z");
  for (const hours of [4, 8, 16, 24, 24]) {
    clock = new Date(planned.state.nextCheckAt);
    planned = planExternalWait({ ...wait, completionPolicy: "all" }, event, { externalWait: planned.state }, { source: "timer" }, clock);
    assert.equal(Date.parse(planned.state.nextCheckAt) - clock.getTime(), hours * 60 * 60_000);
    assert.equal(planned.unchanged, true);
    assert.equal(planned.quiet, true);
  }
  const userReply = planExternalWait(wait, event, { externalWait: planned.state }, undefined, clock);
  assert.equal(userReply.quiet, false);
  assert.equal(userReply.state.unchangedChecks, 0);
  const changed = planExternalWait({ ...wait, reason: "import" }, event, { externalWait: planned.state }, { source: "timer" }, clock);
  assert.equal(changed.quiet, false);
  assert.equal(changed.state.unchangedChecks, 0);
});

test("changed release times and targets notify, while equivalent timestamps and media order do not", () => {
  const initial = planExternalWait({ ...release, mediaIds: ["episode:42", "episode:43"], completionPolicy: "all" }, event, undefined, undefined, now);
  const checkpoint = { externalWait: initial.state };
  const equivalent = planExternalWait({ ...release, availableAt: "2026-11-17T19:00:00-05:00", mediaIds: ["episode:43", "episode:42"], completionPolicy: "all" }, event, checkpoint, { source: "timer" }, now);
  assert.equal(equivalent.quiet, true);
  const changed = planExternalWait({ ...initial.state, availableAt: "2026-12-01T00:00:00Z" }, event, checkpoint, { source: "timer" }, now);
  assert.equal(changed.quiet, false);
  assert.equal(changed.state.nextCheckAt, "2026-12-01T01:00:00.000Z");
  assert.equal(planExternalWait(release, event, checkpoint, { source: "timer" }, now).quiet, false);
});

test("release waits require an exact service timestamp with a timezone and bounded horizon", () => {
  for (const availableAt of [undefined, "2026-11-18", "2026-11-18T00:00:00", "invalid", "2028-11-18T00:00:00Z"]) {
    assert.throws(() => normalizeExternalWait({ ...release, availableAt }, now));
  }
  assert.throws(() => normalizeExternalWait({ ...release, reason: "download" }, now), /only valid for a release wait/);
});
