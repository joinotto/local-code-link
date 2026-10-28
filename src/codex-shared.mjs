import os from "node:os";
import path from "node:path";
import { Agent, WebSocket } from "undici";

// The daemon uses WebSocket framing even on its Unix socket. The stdio proxy
// and a separately spawned app-server are not interchangeable with this socket.
export class CodexSharedClient {
  constructor(options = {}) {
    this.socketPath = options.socketPath || process.env.CODEX_APP_SERVER_SOCKET
      || path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
        "app-server-control", "app-server-control.sock");
    this.timeoutMs = options.timeoutMs || 15_000;
    this.nextId = 1;
    this.pending = new Map();
    this.onMessage = options.onMessage;
    this.onDisconnect = options.onDisconnect;
  }

  async connect() {
    if (this.socket?.readyState === WebSocket.OPEN && this.initialized) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.open().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async open() {
    this.initialized = false;
    this.socket?.close();
    await this.agent?.destroy();
    this.agent = new Agent({ connect: { socketPath: this.socketPath } });
    this.socket = new WebSocket("ws://localhost/", { dispatcher: this.agent });
    const socket = this.socket;
    this.socket.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.method) {
        Promise.resolve(this.onMessage?.(message)).catch((error) =>
          console.error(`Codex event handling: ${error.message}`));
        return;
      }
      const pending = this.pending.get(String(message.id));
      if (!pending || message.method) return;
      this.pending.delete(String(message.id));
      clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(message.error.message || "Codex request failed");
        error.code = message.error.code;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
    });
    const disconnected = () => {
      if (this.socket !== socket) return;
      this.initialized = false;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Shared Codex connection closed"));
      }
      this.pending.clear();
      this.onDisconnect?.();
    };
    this.socket.addEventListener("close", disconnected);
    this.socket.addEventListener("error", disconnected);
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(
          "Cannot connect to the shared Codex server. Start it with local-code-link codex.",
        )), this.timeoutMs);
        this.socket.addEventListener("open", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
        this.socket.addEventListener("error", () => {
          clearTimeout(timer);
          reject(new Error("Cannot connect to the shared Codex server"));
        }, { once: true });
      });
      await this.request("initialize", {
        clientInfo: { name: "local-code-link", title: "LocalCodeLink", version: "0.9.1" },
        capabilities: { experimentalApi: true },
      });
      this.socket.send(JSON.stringify({ method: "initialized" }));
      this.initialized = true;
    } catch (error) {
      this.close();
      throw error;
    }
  }

  request(method, params = {}) {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Shared Codex connection is not open"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`Codex ${method} timed out; check /status before retrying`));
      }, this.timeoutMs);
      this.pending.set(String(id), { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(String(id));
        reject(error);
      }
    });
  }

  respond(id, result) {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error("Shared Codex connection is not open");
    this.socket.send(JSON.stringify({ id, result }));
  }

  close() {
    this.initialized = false;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Shared Codex connection closed"));
    }
    this.pending.clear();
    this.socket?.close();
    void this.agent?.destroy();
  }
}
