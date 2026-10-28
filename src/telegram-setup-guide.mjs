export function telegramSetupGuide(username, challenge) {
  if (!/^[a-z0-9_]+$/i.test(username || "") || !/^[a-f0-9]{32}$/.test(challenge || "")) {
    throw new Error("Telegram setup guidance requires a bot username and fresh pairing code.");
  }
  const addBotUrl = `https://t.me/${username}?startgroup&admin=manage_chat+manage_topics+delete_messages`;
  return [
    "",
    "Finish in Telegram (use your group owner account):",
    "",
    "1. Create or open a private GROUP, not a channel or the bot's direct chat.",
    "   If creating one: Telegram > New Group; choose a name such as Coding.",
    "   In group settings, keep Group Type set to Private (no public username).",
    "",
    "2. Enable Topics in that group.",
    "   Phone: open the group > tap its name > Edit / pencil > Topics > enable > Save / Done.",
    "   Desktop: open the group > ... > Manage Group > Topics > enable > Save.",
    "   Menu names vary by app. If Topics is missing, use the group owner account",
    "   in an up-to-date Telegram mobile or desktop app.",
    "   You do not need to create project topics yourself; LocalCodeLink does that.",
    "",
    `3. Add @${username} as an administrator in the SAME group.`,
    `   Shortcut: ${addBotUrl}`,
    "   Open the link, select your group, review the permissions and confirm.",
    "   Or add manually:",
    `   Group name > Add Members > search @${username} > add the bot.`,
    "   Phone: group name > Edit / pencil > Administrators > Add Administrator > select the bot.",
    "   Desktop: ... > Manage Group > Administrators > Add Administrator > select the bot.",
    "   Enable Manage Topics and Delete Messages, then Save / Done.",
    "   Check both permissions even if you used the shortcut.",
    "   Keep Remain Anonymous off for the account you use to pair.",
    "",
    "4. Send this exact command in that group's General topic:",
    `   /connect ${challenge}`,
    "   Send it yourself as owner/admin, not in the bot's direct chat.",
    "",
    "Return here and wait for the final success message.",
    "LocalCodeLink checks the group and permissions and creates its control topic.",
    "If a check fails, fix the setting and resend the same /connect command",
    "while this setup is waiting. A restarted setup gives you a new code.",
    "",
    "Waiting for /connect (up to 10 minutes)…",
  ].join("\n");
}
