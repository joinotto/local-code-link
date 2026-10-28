import { spawn } from "node:child_process";
import readline from "node:readline";
import { codingEnvironment } from "./provider-environment.mjs";

export class ClaudeStreamClient {
  constructor(options) {
    this.command = options.command;
    this.cwd = options.cwd;
    this.sessionId = options.sessionId;
    this.onApproval = options.onApproval;
    this.onSpawn = options.onSpawn;
    this.timeoutMs = options.timeoutMs || 30 * 60_000;
    this.extraArgs = options.extraArgs || [];
    this.env = options.env || process.env;
    this.messages = [];
  }

  write(message) {
    if (this.child.stdin.destroyed || this.child.stdin.writableEnded) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async handle(message) {
    if (message.type === "control_request" && message.request?.subtype === "can_use_tool") {
      let approved = false;
      let updatedInput;
      try {
        const answer = await this.onApproval(message.request);
        approved = answer === "approve" || answer?.decision === "approve";
        updatedInput = typeof answer === "object" ? answer.updatedInput : undefined;
      } catch {
        approved = false;
      }
      this.write({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: message.request_id,
          response: approved
            ? {
                behavior: "allow",
                updatedInput: updatedInput || message.request.input,
                updatedPermissions: [],
              }
            : {
                behavior: "deny",
                message: "Denied by the user through LocalCodeLink.",
                interrupt: false,
              },
        },
      });
      return;
    }
    if (message.type === "assistant") this.messages.push(message);
    if (message.type === "result") {
      this.result = message;
      this.completed?.(message);
    }
  }

  interrupt() {
    if (!this.child || this.result || this.child.exitCode !== null) return false;
    this.write({ type: "control_request", request_id: `interrupt-${Date.now()}`,
      request: { subtype: "interrupt" } });
    return true;
  }

  async run(prompt, accessMode = "edit") {
    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--permission-prompt-tool", "stdio",
      "--permission-mode", accessMode === "read-only" ? "plan" : "default",
      ...this.extraArgs,
    ];
    if (this.sessionId === "__latest__") args.push("--continue");
    else if (this.sessionId) args.push("--resume", this.sessionId);

    this.child = spawn(this.command, args, {
      cwd: this.cwd,
      env: codingEnvironment(this.env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdin.on("error", (error) => this.failed?.(error));
    this.stderr = "";
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk; });
    readline.createInterface({ input: this.child.stdout }).on("line", (line) => {
      try {
        this.handle(JSON.parse(line)).catch((error) => this.failed?.(error));
      } catch {
        // Ignore non-protocol diagnostics.
      }
    });
    const completion = new Promise((resolve, reject) => {
      this.completed = resolve;
      this.failed = reject;
      this.child.on("error", reject);
      this.child.on("close", (code) => {
        if (!this.result) reject(new Error(this.stderr.slice(-4000)
          || `Claude exited ${code ?? "by signal"} before returning a result`));
      });
    });
    // Install error handlers before an asynchronous state write in onSpawn.
    completion.catch(() => {});
    this.exited = new Promise((resolve) => this.child.once("close", resolve));
    try { await this.onSpawn?.(this.child); } catch (error) {
      this.child.kill("SIGTERM");
      throw error;
    }
    this.write({
      type: "user",
      message: { role: "user", content: prompt },
    });
    let timeout;
    const result = await Promise.race([
      completion,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Claude turn timed out")), this.timeoutMs);
      }),
    ]).catch((error) => {
      this.child.kill("SIGTERM");
      const cleanup = setTimeout(() => this.child.kill("SIGKILL"), 2000);
      cleanup.unref();
      throw error;
    }).finally(() => clearTimeout(timeout));
    this.result = result;
    this.child.stdin.end();
    let exitTimer;
    const exited = await Promise.race([
      this.exited.then(() => true),
      new Promise((resolve) => { exitTimer = setTimeout(() => resolve(false), 2000); }),
    ]).finally(() => clearTimeout(exitTimer));
    if (!exited) this.child.kill("SIGTERM");
    if (result.is_error) throw new Error(result.result || result.errors?.join("\n") || "Claude turn failed");
    return {
      sessionId: result.session_id || this.sessionId,
      text: result.result || "",
      result,
    };
  }
}
