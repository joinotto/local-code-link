import test from "node:test";
import assert from "node:assert/strict";
import { buildLaunchAgent } from "../src/launch-agent.mjs";
test("launch agent escapes spaced/special paths and carries custom state/config locations", () => {
  const text = buildLaunchAgent({ projectRoot: "/tmp/source & <special>",
    stateRoot: "/tmp/state & private", configFile: "/tmp/config & private.env",
    nodeBin: "/tmp/node bin/node", providerBins: { codex: "codex", claude: "/tmp/agents/claude" } });
  assert.ok(text.includes("/tmp/source &amp; &lt;special&gt;/src/cli.mjs"));
  assert.ok(text.includes("<key>LOCAL_CODE_LINK_HOME</key><string>/tmp/state &amp; private</string>"));
  assert.ok(text.includes("/tmp/config &amp; private.env"));
  assert.ok(!text.includes("<string>/tmp/source & <special>"));
  assert.ok(!text.includes(":.:"));
});
test("service definition cannot persist bot/provider/proxy credentials from caller options", () => {
  const text = buildLaunchAgent({ projectRoot: "/tmp/source", stateRoot: "/tmp/state",
    TELEGRAM_BOT_TOKEN: "PRIVATE", AWS_SECRET_ACCESS_KEY: "PRIVATE", HTTPS_PROXY: "PRIVATE" });
  assert.ok(!text.includes("PRIVATE"));
  assert.ok(!text.includes("TELEGRAM_BOT_TOKEN"));
  assert.ok(!text.includes("HTTPS_PROXY"));
});
