// Provider work is never replayed to recover a Telegram delivery failure.
// An uncertain HTTP write is held for an explicit user-controlled retry.
export function deliveryReady(record, timestamp = Date.now()) {
  return !["uncertain", "blocked"].includes(record.delivery?.state)
    && (!record.delivery?.nextAttemptAt || Date.parse(record.delivery.nextAttemptAt) <= timestamp);
}

export function deliveryFailure(record, error, timestamp = Date.now()) {
  const attempts = (record.delivery?.attempts || 0) + 1;
  const state = error.telegramAmbiguous ? "uncertain"
    : [400, 401, 403].includes(error.telegramCode) ? "blocked" : "retrying";
  const delay = Math.max(Number(error.telegramRetryAfter || 0) * 1000,
    Math.min(300_000, 1000 * 2 ** Math.min(attempts, 9)));
  record.delivery = {
    state, attempts, code: error.telegramCode || "NETWORK",
    nextAttemptAt: new Date(timestamp + delay).toISOString(),
  };
}

export function retryDelivery(record) {
  record.delivery = { state: "retrying", attempts: 0 };
}
