import { spawn } from "node:child_process";
import readline from "node:readline";
import { CODEX_QUESTION_METHODS } from "./approval-sync.mjs";
import { codingEnvironment } from "./provider-environment.mjs";

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
]);

export class CodexAppServerClient {
  constructor(options) {
    this.command = options.command;
    this.cwd = options.cwd;
    this.onApproval = options.onApproval;
    this.onSpawn = options.onSpawn;
    this.onQuestion = options.onQuestion;
    this.nextId = 1;
    this.pending = new Map();
    this.messages = [];
    this.finished = false;
  }

  write(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params) {
    const id = this.nextId++;
    this.write({ id, method, params });
    return new Promise((resolve, reject) => this.pending.set(String(id), { resolve, reject }));
  }

  async handle(message) {
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && APPROVAL_METHODS.has(message.method)) {
      try {
        const decision = await this.onApproval(message.method, message.params);
        const approved = decision === "approve";
        const available = message.params.availableDecisions || [];
        const denial = available.includes("decline") ? "decline" : "cancel";
        const result = message.method === "item/permissions/requestApproval"
          ? { permissions: approved ? (message.params.permissions || {}) : {}, scope: "turn" }
          : { decision: approved ? "accept" : denial };
        this.write({
          id: message.id,
          result,
        });
      } catch {
        const available = message.params.availableDecisions || [];
        const denial = available.includes("decline") ? "decline" : "cancel";
        const result = message.method === "item/permissions/requestApproval"
          ? { permissions: {}, scope: "turn" }
          : { decision: denial };
        this.write({ id: message.id, result });
      }
      return;
    }
    if (message.id !== undefined && CODEX_QUESTION_METHODS.has(message.method)) {
      let result = { answers: {} };
      try { result = await this.onQuestion?.(message) || result; } catch { /* no implicit choices */ }
      this.write({ id: message.id, result });
      return;
    }
    if (message.method === "item/completed" && message.params?.item?.type === "agentMessage") {
      this.messages.push(message.params.item.text);
    }
    if (message.method === "turn/completed") {
      this.finished = true;
      this.completed?.(message.params);
    }
  }

  async start() {
    this.child = spawn(this.command, ["app-server", "--stdio"], {
      cwd: this.cwd,
      env: codingEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.onSpawn?.(this.child);
    this.stderr = "";
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk; });
    this.child.on("error", (error) => {
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.completionReject?.(error);
    });
    this.child.on("close", (code) => {
      if (!this.finished) {
        const error = new Error(this.stderr || `Codex app-server exited ${code}`);
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
        this.completionReject?.(error);
      }
    });
    readline.createInterface({ input: this.child.stdout }).on("line", (line) => {
      try {
        this.handle(JSON.parse(line)).catch(() => {});
      } catch {
        // App-server diagnostics that are not JSON are ignored.
      }
    });
    await this.request("initialize", {
      clientInfo: { name: "local-code-link", title: "LocalCodeLink", version: "0.9.0" },
      capabilities: null,
    });
    this.write({ method: "initialized" });
  }

  async run(prompt, sessionId, accessMode = "edit") {
    await this.start();
    const common = {
      cwd: this.cwd,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: accessMode === "read-only" ? "read-only" : "workspace-write",
    };
    const threadResult = sessionId
      ? await this.request("thread/resume", { threadId: sessionId, ...common })
      : await this.request("thread/start", { ...common, ephemeral: false });
    const threadId = threadResult.thread.id;
    const completion = new Promise((resolve, reject) => {
      this.completed = resolve;
      this.completionReject = reject;
    });
    await this.request("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt }],
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
    });
    let timeout;
    const turn = await Promise.race([
      completion,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Codex turn timed out")), 30 * 60_000);
      }),
    ]).finally(() => clearTimeout(timeout));
    this.child.kill("SIGTERM");
    return {
      sessionId: threadId,
      text: this.messages.at(-1) || "",
      turn,
    };
  }
}
