import { fetch as undiciFetch, ProxyAgent } from "undici";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MAX_MESSAGE = 4000;
const NETWORK_RETRIES = 3;
const NETWORK_TIMEOUT_MS = 15_000;

const wait = (milliseconds, signal) => new Promise((resolve) => {
  if (signal?.aborted) return resolve();
  const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
  const timer = setTimeout(done, milliseconds);
  signal?.addEventListener("abort", done, { once: true });
});
// These operations can be repeated without creating a second message/topic.
const repeatable = new Set(["getMe", "getChat", "getChatMember", "getUpdates", "getWebhookInfo",
  "deleteWebhook", "setMyDefaultAdministratorRights", "editMessageText",
  "answerCallbackQuery", "closeForumTopic", "deleteForumTopic"]);

const execute = (command, args, signal) => new Promise((resolve, reject) => {
  execFile(command, args, { maxBuffer: 10 * 1024 * 1024, signal }, (error, stdout, stderr) => {
    if (error) {
      error.stderr = stderr;
      reject(error);
    } else {
      resolve(stdout);
    }
  });
});

const curlQuote = (value) => String(value).replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");

async function curlFetch(url, body, timeoutMs = NETWORK_TIMEOUT_MS, signal) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "local-code-link-telegram-"));
  const configFile = path.join(directory, "curl.conf");
  const bodyFile = path.join(directory, "body.json");
  try {
    await writeFile(bodyFile, JSON.stringify(body), { mode: 0o600 });
    await writeFile(configFile, [
      `url = "${curlQuote(url)}"`,
      'request = "POST"',
      'header = "content-type: application/json"',
      "silent",
      "show-error",
      "connect-timeout = 15",
      `max-time = ${Math.ceil(timeoutMs / 1000)}`,
      'write-out = "\\n%{http_code}"',
      "",
    ].join("\n"), { mode: 0o600 });
    const output = await execute("curl", [
      "--config", configFile,
      "--data-binary", `@${bodyFile}`,
    ], signal);
    const separator = output.lastIndexOf("\n");
    const text = separator >= 0 ? output.slice(0, separator) : output;
    const status = Number(separator >= 0 ? output.slice(separator + 1) : 0);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => JSON.parse(text),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function telegramNetworkError(method, error, ambiguous = false) {
  const code = error?.cause?.code
    || error?.cause?.errors?.find((item) => item?.code)?.code
    || error?.code;
  const detail = code ? ` (${code})` : "";
  const result = new Error(
    `Could not reach Telegram while calling ${method}${detail}. `
    + (ambiguous ? "Delivery is uncertain; inspect Telegram before explicitly retrying. "
      : "Check your internet connection, VPN, proxy, or firewall, then try again."),
  );
  result.telegramAmbiguous = ambiguous;
  return result;
}

export class TelegramClient {
  constructor(token, options = {}) {
    if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required. Run: local-code-link setup telegram");
    this.baseUrl = `https://api.telegram.org/bot${token}`;
    const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
    const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
    this.fetch = options.fetch || ((url, init) => undiciFetch(url, {
      ...init,
      ...(dispatcher ? { dispatcher } : {}),
    }));
    this.offset = 0;
    this.stopped = false;
    this.pollAbort = new AbortController();
    this.wait = options.wait || wait;
    this.retryAt = 0;
    this.fallback = options.fallback || curlFetch;
  }

  async request(method, body = {}) {
    if (method === "getUpdates" && this.stopped) return [];
    const timeoutMs = method === "getUpdates"
      ? Math.max(NETWORK_TIMEOUT_MS, (Number(body.timeout) + 10) * 1000)
      : NETWORK_TIMEOUT_MS;
    const signal = method === "getUpdates" ? this.pollAbort.signal : undefined;
    for (let attempt = 1; attempt <= NETWORK_RETRIES; attempt += 1) {
      await this.wait(Math.max(0, this.retryAt - Date.now()), signal);
      if (method === "getUpdates" && this.stopped) return [];
      let response;
      let usedFallback = Boolean(this.useFallback);
      try {
        response = this.useFallback
          ? await this.fallback(`${this.baseUrl}/${method}`, body, timeoutMs, signal)
          : await this.fetch(`${this.baseUrl}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: method === "getUpdates"
            ? AbortSignal.any([AbortSignal.timeout(timeoutMs), this.pollAbort.signal])
            : AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        if (method === "getUpdates" && this.stopped) return [];
        // A network failure does not prove that Telegram rejected a write.
        if (!repeatable.has(method)) throw telegramNetworkError(method, error, true);
        if (attempt < NETWORK_RETRIES) {
          await this.wait(attempt * 500, signal);
          continue;
        }
        if (this.useFallback) throw telegramNetworkError(method, error);
        try {
          response = await this.fallback(`${this.baseUrl}/${method}`, body, timeoutMs, signal);
          usedFallback = true;
        } catch (curlError) {
          if (method === "getUpdates" && this.stopped) return [];
          throw telegramNetworkError(method, curlError);
        }
      }
      let payload;
      try { payload = await response.json(); } catch { payload = null; }
      if (response.ok && payload?.ok) {
        // Probe transport with safe reads first. If curl is the working path,
        // future writes use it directly rather than failing and duplicating.
        this.useFallback ||= usedFallback;
        return payload.result;
      }
      const error = new Error(`Telegram ${method} failed: ${payload?.description || response.status}`);
      error.telegramCode = payload?.error_code || response.status;
      error.telegramDescription = payload?.description || "";
      if (error.telegramCode === 429) {
        const seconds = Number(payload?.parameters?.retry_after);
        error.telegramRetryAfter = Number.isFinite(seconds) && seconds > 0 ? seconds : 1;
        this.retryAt = Date.now() + error.telegramRetryAfter * 1000;
        if (attempt < NETWORK_RETRIES) continue;
      }
      if (!repeatable.has(method) && (!payload || response.status >= 500)) {
        error.telegramAmbiguous = true;
      }
      if (repeatable.has(method) && response.status >= 500 && attempt < NETWORK_RETRIES) {
        await this.wait(attempt * 500, signal);
        continue;
      }
      throw error;
    }
  }

  getMe() {
    return this.request("getMe");
  }

  getChat(chatId) {
    return this.request("getChat", { chat_id: chatId });
  }

  getChatMember(chatId, userId) {
    return this.request("getChatMember", { chat_id: chatId, user_id: userId });
  }

  getUpdates(options = {}) {
    return this.request("getUpdates", {
      offset: options.offset,
      timeout: options.timeout || 0,
      allowed_updates: options.allowedUpdates || ["message", "callback_query"],
    });
  }

  deleteWebhook() {
    return this.request("deleteWebhook", { drop_pending_updates: false });
  }

  getWebhookInfo() {
    return this.request("getWebhookInfo");
  }

  setDefaultAdministratorRights() {
    return this.request("setMyDefaultAdministratorRights", {
      rights: {
        is_anonymous: false,
        can_manage_chat: true,
        can_delete_messages: true,
        can_manage_topics: true,
      },
      for_channels: false,
    });
  }

  createForumTopic(chatId, name) {
    return this.request("createForumTopic", { chat_id: chatId, name: String(name).slice(0, 128) });
  }

  closeForumTopic(chatId, topicId) {
    return this.request("closeForumTopic", {
      chat_id: chatId,
      message_thread_id: Number(topicId),
    });
  }

  async deleteForumTopic(chatId, topicId) {
    try {
      return await this.request("deleteForumTopic", {
        chat_id: chatId,
        message_thread_id: Number(topicId),
      });
    } catch (error) {
      // An earlier successful delete may have lost its HTTP response. Retrying
      // that exact saved topic is safe; permission/network errors are not success.
      if (error.telegramCode === 400
        && /TOPIC_(?:ID_INVALID|DELETED|NOT_FOUND)|message thread not found/i
          .test(error.telegramDescription || "")) return true;
      throw error;
    }
  }

  async sendMessage(chatId, text, options = {}) {
    const chunks = splitTelegramText(String(text || "(empty)"));
    let result;
    for (const [index, chunk] of chunks.entries()) {
      try {
        result = await this.request("sendMessage", {
        chat_id: chatId,
        text: chunk,
        disable_web_page_preview: true,
        ...(options.topicId ? { message_thread_id: Number(options.topicId) } : {}),
        ...(index === chunks.length - 1 && options.replyMarkup
          ? { reply_markup: options.replyMarkup }
          : {}),
        });
      } catch (error) {
        // Previously acknowledged chunks must not be sent again automatically.
        if (index > 0) error.telegramAmbiguous = true;
        throw error;
      }
    }
    return result;
  }

  answerCallbackQuery(id, text) {
    return this.request("answerCallbackQuery", {
      callback_query_id: id,
      ...(text ? { text: String(text).slice(0, 180) } : {}),
    });
  }

  editMessageText(chatId, messageId, text, replyMarkup = { inline_keyboard: [] }) {
    return this.request("editMessageText", {
      chat_id: chatId, message_id: Number(messageId),
      text: String(text).slice(0, 4000), reply_markup: replyMarkup,
    }).catch((error) => {
      if (/message is not modified/i.test(error.telegramDescription || "")) return true;
      throw error;
    });
  }
  stop() {
    this.stopped = true;
    this.pollAbort.abort();
  }

  async poll(handler) {
    while (!this.stopped) {
      try {
        const updates = await this.request("getUpdates", {
          offset: this.offset,
          timeout: 30,
          allowed_updates: ["message", "callback_query"],
        });
        for (const update of updates) {
          // Persist/accept the update before asking Telegram to discard it.
          // Model execution is dispatched asynchronously by the service.
          await handler(update);
          this.offset = Math.max(this.offset, update.update_id + 1);
          await this.onOffset?.(this.offset);
        }
      } catch (error) {
        if (this.stopped) return;
        if (error.telegramCode === 409) {
          throw new Error("Another process is polling this Telegram bot. Stop it before starting LocalCodeLink.");
        }
        if ([401, 403].includes(error.telegramCode)) {
          throw new Error("Telegram access was rejected. Check the bot token and permissions, then rerun setup.");
        }
        console.error(error.message);
        await this.wait(Math.max(2000, this.retryAt - Date.now()), this.pollAbort.signal);
      }
    }
  }
}

export async function validateTelegramGroup(client, bot, chatId) {
  const chat = await client.getChat(chatId);
  if (chat.type !== "supergroup" || !chat.is_forum || chat.username || chat.active_usernames?.length) {
    throw new Error("Use a private forum-enabled supergroup with no public username.");
  }
  const membership = await client.getChatMember(chat.id, bot.id);
  if (!["administrator", "creator"].includes(membership.status)
    || membership.status === "administrator" && (!membership.can_manage_topics || !membership.can_delete_messages)) {
    throw new Error("Give the bot administrator permissions for Manage Topics and Delete Messages.");
  }
  return chat;
}

export async function waitForTelegramConnect(client, bot, options = {}) {
  if (!/^[a-f0-9]{32}$/.test(options.challenge || "")) throw new Error("Setup requires a fresh pairing challenge.");
  const timeoutMs = options.timeoutMs || 10 * 60 * 1000;
  const onRejected = options.onRejected || (() => {});
  const webhook = await client.getWebhookInfo();
  if (webhook.url) throw new Error("This bot has an existing webhook. Use a dedicated bot or remove that webhook explicitly; LocalCodeLink did not replace it.");
  await client.deleteWebhook();

  const pending = await client.getUpdates({ timeout: 0, allowedUpdates: ["message"] });
  let offset = 0;
  let initial = pending;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    // The nonce makes old commands invalid. Do not discard a fast owner's
    // valid response just because it arrived before this first polling call.
    const updates = initial ?? await client.getUpdates({
      offset,
      timeout: Math.min(20, Math.max(1, Math.ceil((deadline - Date.now()) / 1000))),
      allowedUpdates: ["message"],
    });
    initial = null;
    for (const update of updates) {
      offset = Math.max(offset, update.update_id + 1);
      const message = update.message;
      const match = /^\/connect(?:@(\w+))?\s+([a-f0-9]{32})\s*$/i.exec(message?.text || "");
      if (!message?.from || message.from.is_bot || !match || match[2] !== options.challenge
        || match[1] && match[1].toLowerCase() !== bot.username?.toLowerCase()) continue;
      let chat;
      try {
        chat = await validateTelegramGroup(client, bot, message.chat.id);
        const requester = await client.getChatMember(chat.id, message.from.id);
        if (!["creator", "administrator"].includes(requester.status)) {
          throw new Error("Send the pairing command from a real group owner or administrator account.");
        }
      } catch (error) {
        if (error.telegramCode === 401) throw error;
        await onRejected(error.message);
        continue;
      }
      return {
        chatId: String(chat.id),
        chatTitle: chat.title || "Telegram group",
        userId: String(message.from.id),
        userName: message.from.username || message.from.first_name || String(message.from.id),
        updateOffset: offset,
      };
    }
  }
  throw new Error("Timed out waiting for /connect. Run setup again when the Telegram group is ready.");
}

export function splitTelegramText(text) {
  if (text.length <= MAX_MESSAGE) return [text];
  const chunks = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + MAX_MESSAGE, text.length);
    // Telegram expects valid Unicode; never split an emoji surrogate pair.
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

export function approvalKeyboard(approvalId) {
  return {
    inline_keyboard: [[
      { text: "✅ Approve once", callback_data: `approval:${approvalId}:approve` },
      { text: "❌ Deny", callback_data: `approval:${approvalId}:deny` },
    ]],
  };
}
