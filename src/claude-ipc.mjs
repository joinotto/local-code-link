import net from "node:net";
import { createHash } from "node:crypto";
import path from "node:path";

export function claudeSocketPath(root, project) {
  const id = createHash("sha256").update(JSON.stringify([
    root, project.id, project.linkId || project.topicId,
  ])).digest("hex").slice(0, 20);
  return path.join(root, "claude", `${id}.sock`);
}

// Filesystem permissions gate access. Every command also carries the immutable
// link generation; an old topic/session cannot act on a newly linked project.
export function claudeRequest(root, project, method, params = {}, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(claudeSocketPath(root, project));
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Claude bridge ${method} timed out`));
    }, timeoutMs);
    const finish = (error, result) => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    socket.once("error", (error) => finish(error));
    socket.once("connect", () => socket.write(`${JSON.stringify({
      projectId: project.id, linkId: project.linkId || project.topicId, method, params,
    })}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 2_000_000) return finish(new Error("Claude bridge response is too large"));
      if (!buffer.includes("\n")) return;
      try {
        const message = JSON.parse(buffer.split("\n")[0]);
        finish(message.error ? new Error(message.error) : null, message.result);
      } catch (error) { finish(error); }
    });
    socket.once("end", () => {
      if (!buffer.includes("\n")) finish(new Error("Claude bridge disconnected"));
    });
  });
}
