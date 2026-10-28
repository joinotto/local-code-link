import { claudeRequest } from "./claude-ipc.mjs";
import { approvalDecisionNotice } from "./approval-sync.mjs";

const [root, projectId, linkId] = process.argv.slice(2);
let raw = "";
let managed = false;
for await (const chunk of process.stdin) {
  raw += chunk;
  if (raw.length > 2_000_000) break;
}
try {
  const input = JSON.parse(raw);
  const project = { id: projectId, linkId };
  let result = await claudeRequest(root, project, "hook", input, 3000);
  if (result?._localCodeLinkWait) {
    managed = true;
    const answers = {};
    const notices = [];
    let denied = false;
    let fallback = false;
    const deadline = Date.now() + 15 * 60_000;
    for (const [index, id] of result._localCodeLinkWait.entries()) {
      let answer;
      while (Date.now() < deadline) {
        answer = await claudeRequest(root, project, "panel-result", { id }, 3000);
        if (answer.done || answer.fallback) break;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      if (answer?.fallback) { fallback = true; break; }
      const notice = approvalDecisionNotice(answer?.notice);
      if (notice) notices.push(notice);
      if (!answer?.done || answer.cancelled || answer.behavior === "deny") { denied = true; break; }
      if (result.kind === "question") answers[input.tool_input.questions[index].question] = answer.answer;
    }
    result = fallback ? {} : {
      ...(notices.length ? { systemMessage: notices.join("\n") } : {}),
      hookSpecificOutput: input.hook_event_name === "PermissionRequest"
        ? { hookEventName: "PermissionRequest", decision: denied
          ? { behavior: "deny", message: "Denied or cancelled by the user through LocalCodeLink." }
          // Do not redundantly supply updatedInput. Claude re-evaluates changed
          // input against ask rules, which can re-open the native dialog after
          // the shared decision. This approval does not modify tool arguments.
          : { behavior: "allow" } }
        : { hookEventName: "PreToolUse", permissionDecision: denied ? "deny" : "allow",
          ...(denied ? { permissionDecisionReason: "Question cancelled by the user." }
            : { updatedInput: { ...input.tool_input, answers } }) },
    };
  }
  process.stdout.write(`${JSON.stringify(result || {})}\n`);
} catch (error) {
  // An unavailable bridge must never replace, approve, deny or block the native
  // prompt. Leave the local CLI functional, with a terminal-only diagnostic.
  let fallback = { systemMessage: `LocalCodeLink: ${error.message}. Use the local Claude terminal.` };
  if (managed) {
    let input;
    try { input = JSON.parse(raw); } catch { /* Never grant on parse failure. */ }
    fallback = {
      systemMessage: `LocalCodeLink lost its approval connection. The action was not approved: ${error.message}`,
      hookSpecificOutput: input?.hook_event_name === "PermissionRequest"
        ? { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "Approval connection lost." } }
        : { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Approval connection lost." },
    };
  }
  process.stdout.write(`${JSON.stringify(fallback)}\n`);
}
