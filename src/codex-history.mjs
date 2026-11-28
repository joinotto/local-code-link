// Read paginated history through the daemon that owns the thread. Never infer
// completion from another turn's reply or from notification timing alone.
export const codexRequestMarker = (id) => `[LocalCodeLink Telegram request ${id}]`;
const pageLimit = 100;
const maxPages = 100;

function page(result) {
  if (!Array.isArray(result?.data)
    || result.nextCursor != null && (typeof result.nextCursor !== "string" || !result.nextCursor)) {
    throw new Error("Codex returned invalid history pagination; the pending request was preserved.");
  }
  return result;
}

const unmaterialized = (error) => error.codexRejected === true
  && /is not materialized yet;.*unavailable before first user message/i.test(error.message || "");

export async function codexHistoryBoundary(client, threadId) {
  let turns;
  try {
    turns = page(await client.request("thread/turns/list", {
      threadId, itemsView: "notLoaded", sortDirection: "desc", limit: 1,
    }));
  } catch (error) {
    if (unmaterialized(error)) return null;
    throw error;
  }
  // Check item-pagination support before accepting a Telegram prompt.
  page(await client.request("thread/items/list", {
    threadId, ...(turns.data[0] ? { turnId: turns.data[0].id } : {}),
    sortDirection: "desc", limit: 1,
  }));
  return turns.data[0]?.id || null;
}

function matchesRequest(item, requestId) {
  return item?.type === "userMessage" && (item.clientId === requestId
    || item.clientId == null && item.content?.some((input) => input.type === "text"
      && input.text?.startsWith(`${codexRequestMarker(requestId)}\n`)));
}

async function inspectTurn(client, request, turn) {
  let cursor;
  let matched = false;
  let answer;
  const cursors = new Set();
  for (let count = 0; count < maxPages; count++) {
    const result = page(await client.request("thread/items/list", {
      threadId: request.sessionId, turnId: turn.id, sortDirection: "desc",
      limit: pageLimit, ...(cursor ? { cursor } : {}),
    }));
    for (const entry of result.data) {
      if (entry.turnId !== turn.id) {
        throw new Error("Codex returned history for an unexpected turn; the pending request was preserved.");
      }
      const item = entry.item;
      if (matchesRequest(item, request.id)) matched = true;
      // Descending order: retain only the last terminal/legacy assistant reply.
      // Commentary, partial answers, reasoning and tool output are not results.
      if (answer === undefined && item?.type === "agentMessage"
        && (item.phase == null || item.phase === "final_answer") && typeof item.text === "string") {
        answer = item.text;
      }
    }
    if (!result.nextCursor) {
      if (!matched) return null;
      if (turn.status === "inProgress") return { turnId: turn.id };
      if (turn.status === "interrupted") {
        return { turnId: turn.id, output: "⏹ Telegram request interrupted." };
      }
      if (turn.status === "failed") {
        return { turnId: turn.id, output: "❌ Codex task failed. Check the existing Codex session for details." };
      }
      if (turn.status === "completed") return { turnId: turn.id, output: answer || "Completed." };
      throw new Error("Codex returned an unknown turn status; the pending request was preserved.");
    }
    if (cursors.has(result.nextCursor)) throw new Error("Codex history pagination did not advance.");
    cursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new Error("Codex turn history exceeded the pagination limit; the pending request was preserved.");
}

export async function findCodexHistoryResult(client, request) {
  let cursor;
  const cursors = new Set();
  for (let count = 0; count < maxPages; count++) {
    let result;
    try {
      result = page(await client.request("thread/turns/list", {
        threadId: request.sessionId, itemsView: "notLoaded", sortDirection: "desc",
        limit: pageLimit, ...(cursor ? { cursor } : {}),
      }));
    } catch (error) {
      if (unmaterialized(error)) return null;
      throw error;
    }
    for (const turn of result.data) {
      if (typeof turn?.id !== "string" || !turn.id) throw new Error("Codex returned an invalid history turn.");
      if (turn.id === request.turnId && turn.status === "inProgress") return { turnId: turn.id };
      if (!request.turnId || turn.id === request.turnId) {
        const match = await inspectTurn(client, request, turn);
        if (match) return match;
      }
      // Include the boundary turn: a native client can consume queued input in
      // the already-active turn. Never scan the rest of the old conversation.
      if (turn.id === request.historyAfterTurnId) return null;
    }
    if (!result.nextCursor) return null;
    if (cursors.has(result.nextCursor)) throw new Error("Codex history pagination did not advance.");
    cursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new Error("Codex recent history exceeded the pagination limit; the pending request was preserved.");
}
