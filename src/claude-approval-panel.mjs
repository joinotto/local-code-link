import { claudeRequest } from "./claude-ipc.mjs";
import { approvalDecisionNotice } from "./approval-sync.mjs";

export const terminalText = (text) => String(text)
  .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "");

export class ClaudeApprovalPanel {
  constructor(root, project, options = {}) {
    this.root = root;
    this.project = project;
    this.write = options.write || ((text) => process.stdout.write(text));
    this.refresh = options.refresh || (() => {});
    this.input = "";
    this.sending = false;
  }

  show(approval, previous) {
    const closed = this.active && (!approval || approval.id !== this.active.id);
    const opened = approval && !this.active;
    this.active = approval;
    this.input = "";
    if (closed) {
      if (!approval) this.write("\x1b[?1049l");
      this.write(`\n${terminalText(typeof previous === "string" ? previous
        : approvalDecisionNotice(previous) || `LocalCodeLink: request ${previous?.status || "closed"}.`)}\n`);
      this.refresh();
    }
    if (!approval) return;
    if (opened) this.write("\x1b[?1049h");
    this.write("\x1b[2J\x1b[H");
    const question = approval.details.question;
    this.write(`\n── LocalCodeLink · ${terminalText(this.project.name)} ──\nRequest: ${approval.id}\n`);
    if (question) {
      this.write(`${terminalText(question.question)}\n`);
      for (const [index, option] of (question.options || []).entries()) {
        this.write(`  ${index + 1}. ${terminalText(option.label)} — ${terminalText(option.description || "")}\n`);
      }
      this.write(`${question.multiSelect ? "Enter numbers separated by commas" : "Enter an option number"} or type an answer, then Enter.\n> `);
    } else {
      this.write(`${terminalText(approval.toolName)}: ${terminalText(JSON.stringify(approval.details.input, null, 2))}\n`);
      this.write("[a] Approve once   [d] Deny   [Esc] Deny\n");
    }
  }

  handle(data) {
    const approval = this.active;
    if (!approval) return false;
    if (this.sending) return true;
    if (approval.type === "question") {
      if (data === "\x1b" || data === "\x03") {
        // Explicit interruption, not a fabricated answer.
        this.sending = true;
        claudeRequest(this.root, this.project, "interrupt").catch(() => {})
          .finally(() => { this.sending = false; });
        return true;
      }
      for (const char of data.replace(/\x1b\[20[01]~/g, "")) {
        if (char === "\r" || char === "\n") {
          if (!this.input.trim()) continue;
          const question = approval.details.question;
          const numbers = this.input.trim().split(",").map((value) => value.trim());
          const numeric = numbers.every((value) => /^\d+$/.test(value)
            && question.options?.[Number(value) - 1]);
          const answer = numeric ? numbers.map((value) => question.options[Number(value) - 1].label).join(", ")
            : this.input.trim();
          this.send(approval.id, { answer });
          break;
        } else if (char === "\x7f" || char === "\b") {
          this.input = this.input.slice(0, -1); this.write("\b \b");
        } else if (terminalText(char)) {
          if (this.input.length < 5000) { this.input += char; this.write(terminalText(char)); }
        }
      }
    } else {
      // Ignore paste, arbitrary text and trailing buffered bytes: they must not
      // accidentally approve a pending action.
      if (data === "a" || data === "A") this.send(approval.id, { decision: "approve" });
      if (["d", "D", "\x1b", "\x03"].includes(data)) this.send(approval.id, { decision: "deny" });
    }
    return true;
  }

  send(id, params) {
    this.sending = true;
    claudeRequest(this.root, this.project, "panel-decide", { id, ...params }).catch((error) => {
      this.write(`\n${terminalText(error.message)}\n`);
    }).finally(() => { this.sending = false; });
  }
}
