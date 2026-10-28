import test from "node:test";
import assert from "node:assert/strict";
import { telegramSetupGuide } from "../src/telegram-setup-guide.mjs";

test("first-time Telegram guidance covers topics, manual admin setup and exact group pairing", () => {
  const challenge = "a".repeat(32);
  const text = telegramSetupGuide("fixture_bot", challenge);
  assert.match(text, /private GROUP, not a channel/);
  assert.match(text, /Phone:.*Edit \/ pencil > Topics > enable > Save \/ Done/);
  assert.match(text, /Desktop:.*Manage Group > Topics > enable > Save/);
  assert.match(text, /do not need to create project topics yourself/);
  assert.match(text, /Group name > Add Members > search @fixture_bot/);
  assert.match(text, /Phone:.*Administrators > Add Administrator > select the bot/);
  assert.match(text, /Desktop:.*Administrators > Add Administrator > select the bot/);
  assert.match(text, /Enable Manage Topics and Delete Messages/);
  assert.match(text, /Check both permissions even if you used the shortcut/);
  assert.match(text, /Remain Anonymous off/);
  assert.match(text, /group's General topic/);
  assert.match(text, new RegExp(`/connect ${challenge}`));
  assert.equal(text.split(`/connect ${challenge}`).length - 1, 1);
  assert.match(text, /resend the same \/connect command/);
  assert.match(text, /up to 10 minutes/);
  assert.match(text, /https:\/\/t\.me\/fixture_bot\?startgroup&admin=manage_chat\+manage_topics\+delete_messages/);
});

test("setup guidance rejects invalid bot identities and stale or injected pairing values", () => {
  for (const [username, challenge] of [
    [undefined, "a".repeat(32)],
    ["fixture\nbot", "a".repeat(32)],
    ["fixture_bot", ""],
    ["fixture_bot", "a".repeat(31)],
    ["fixture_bot", `${"a".repeat(32)}\nextra`],
  ]) assert.throws(() => telegramSetupGuide(username, challenge), /fresh pairing code/);
});
