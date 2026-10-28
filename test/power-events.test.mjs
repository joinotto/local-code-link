import test from "node:test";
import assert from "node:assert/strict";
import { parsePowerEvents, readPowerEvents } from "../scripts/power-events.mjs";

test("hardware verifier distinguishes full sleep/wake from dark/display wakes without exposing raw logs", () => {
  const events = parsePowerEvents([
    "2026-10-27 13:00:00 +0530 Sleep       Entering Sleep state due to 'Software Sleep'",
    "2026-10-27 13:00:10 +0530 DarkWake    DarkWake from Deep Idle PRIVATE_APP",
    "2026-10-27 13:00:30 +0530 Wake        Wake from Deep Idle PRIVATE_APP",
    "unrelated private process info",
  ].join("\n"));
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => event.type), ["Sleep", "Wake"]);
  assert.equal(events[1].timestamp - events[0].timestamp, 30000);
  assert.ok(!JSON.stringify(events).includes("PRIVATE_APP"));
});

test("power-log read retries a timeout across wake without fabricating events", async () => {
  let calls = 0;
  const events = await readPowerEvents({ execute: async () => {
    if (++calls === 1) throw Object.assign(new Error("timeout"), { killed: true, signal: "SIGTERM" });
    return { stdout: "2026-10-27 13:00:30 +0530 Wake        Wake from Deep Idle PRIVATE_APP" };
  } });
  assert.equal(calls, 2);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "Wake");
  assert.ok(!JSON.stringify(events).includes("PRIVATE_APP"));
});

test("power-log retry is bounded and does not hide unrelated errors", async () => {
  let calls = 0;
  await assert.rejects(readPowerEvents({ execute: async () => {
    calls++;
    throw Object.assign(new Error("timeout"), { killed: true, signal: "SIGTERM" });
  } }), /timeout/);
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(readPowerEvents({ execute: async () => {
    calls++;
    throw Object.assign(new Error("permission denied"), { code: "EACCES" });
  } }), /permission denied/);
  assert.equal(calls, 1);
});
