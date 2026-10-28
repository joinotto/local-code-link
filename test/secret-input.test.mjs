import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { readSecret } from "../src/secret-input.mjs";

function fixture() {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (value) => { input.isRaw = value; };
  const output = new PassThrough();
  let visible = "";
  output.on("data", (chunk) => { visible += chunk; });
  return { input, output, visible: () => visible };
}
test("bot token entry never echoes the token and restores terminal state", async () => {
  const f = fixture();
  const result = readSecret("Token", f);
  f.input.write("12345:PRIVATE_TEST_TOKEN\r");
  assert.equal(await result, "12345:PRIVATE_TEST_TOKEN");
  assert.equal(f.visible(), "Token (hidden): \n");
  assert.equal(f.input.isRaw, false);
  assert.equal(f.input.listenerCount("data"), 0);
});
test("hidden token paste handles fragmented bracketed-paste markers and backspace", async () => {
  const f = fixture();
  const result = readSecret("Token", f);
  f.input.write("\x1b[20");
  f.input.write("0~12345:TESTR\x7f\x1b[201~\r");
  assert.equal(await result, "12345:TEST");
  assert.ok(!f.visible().includes("TEST"));
});
test("cancelled and piped token entry cannot leak credentials", async () => {
  const f = fixture();
  const result = readSecret("Token", f);
  f.input.write("PRIVATE\x03");
  await assert.rejects(result, /cancelled/);
  assert.equal(f.input.isRaw, false);
  assert.ok(!f.visible().includes("PRIVATE"));
  await assert.rejects(readSecret("Token", { input: new PassThrough(), output: f.output }), /interactive terminal/);
});
