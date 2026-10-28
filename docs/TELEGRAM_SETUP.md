# Telegram group setup

Pair Telegram once; later projects reuse the configured bot and group.
Enter your BotFather token only at LocalCodeLink's hidden terminal prompt.

## 1. Create or open a private group

Use **New Group**, not New Channel or a direct chat with your bot.
A name such as `Coding` is fine. In group settings, keep **Group Type**
set to **Private**, with no public username.
Use your group owner account for setup.

## 2. Enable Topics

- Phone: open the group → tap its name → **Edit** or the pencil icon →
  **Topics** → enable → **Save** or **Done**.
- Telegram Desktop: open the group → **…** → **Manage Group** →
  **Topics** → enable → **Save**.

Menu names vary between Telegram apps. If Topics is missing, check that you
are using the group owner account in an up-to-date mobile or desktop app.
You do not need to create project topics manually.
LocalCodeLink creates its control topic and each linked project's topic.

## 3. Add your bot as an administrator

The setup wizard prints an add-bot link for your specific bot. Open it, choose
the same group, review the requested permissions and confirm.

If adding manually:

1. Open the group's profile → **Add Members** → search for your bot's exact
   `@username` → add it.
2. On mobile, open the group profile → **Edit** or pencil →
   **Administrators** → **Add Administrator** → select the bot.
   On Telegram Desktop, use **…** → **Manage Group** →
   **Administrators** → **Add Administrator**.
3. Enable **Manage Topics** and **Delete Messages**, then save.
   Check both permissions even if you used the add-bot link.

The pairing account must be a real owner/admin account.
Keep **Remain Anonymous** off for that account when sending the pairing command.
The bot cannot grant itself administrator permissions.

## 4. Pair and wait for success

Send the exact `/connect CODE` printed by the CLI in the group's **General**
topic, from your owner/admin account. Do not send it in the bot's direct chat.

Leave setup running in the terminal. It waits up to 10 minutes, validates your
group and bot permissions, creates the control topic, saves the private
configuration and starts the background service on macOS.

If a validation check fails, fix the setting and resend the same command
while the wizard is still waiting. If you restart setup, use its newly printed
code instead.

You do not need to find or enter Telegram chat IDs or user IDs.

## References

- [Telegram Topics settings](https://telegram.org/blog/direct-to-channel-trim-voice-and-more)
- [Telegram administrator setup](https://telegram.org/faq#q-how-do-i-add-more-administrators)
- [Telegram bot administrator permissions](https://core.telegram.org/bots/api#chatadministratorrights)
