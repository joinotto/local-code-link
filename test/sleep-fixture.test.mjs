import test from "node:test";
import assert from "node:assert/strict";
import { isBoundedSleepCommand } from "../scripts/sleep-fixture.mjs";

test("hardware fixture permits only the exact bounded command and trusted shell wrappers", () => {
  for (const value of ["/bin/sleep 1800", "/bin/zsh -lc '/bin/sleep 1800'",
    '/bin/bash -c "/bin/sleep 1800"', ["/bin/sh", "-c", "/bin/sleep 1800"]]) {
    assert.equal(isBoundedSleepCommand(value), true);
  }
  for (const value of [undefined, "/bin/sleep 1800; touch surprise", "/bin/sleep 9999",
    ["/evil/shell", "-lc", "/bin/sleep 1800"], ["/bin/zsh", "-lc", "/bin/sleep 1800", "extra"],
    "/bin/zsh -lc '/bin/sleep 1800; touch surprise'", ["python", "/bin/sleep 1800"]]) {
    assert.equal(isBoundedSleepCommand(value), false);
  }
});
