import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);

export function parsePowerEvents(text) {
  return text.split(/\r?\n/).flatMap((line) => {
    const match = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) ([+-]\d{4})\s+(Sleep|Wake)\s+(.*)$/.exec(line);
    if (!match || !(match[4] === "Sleep" ? /Entering Sleep state/.test(match[5]) : /Wake from/.test(match[5]))) return [];
    const offset = `${match[3].slice(0, 3)}:${match[3].slice(3)}`;
    const timestamp = Date.parse(`${match[1]}T${match[2]}${offset}`);
    return Number.isFinite(timestamp) ? [{ type: match[4], timestamp,
      key: `${timestamp}:${match[4]}` }] : [];
  });
}

export async function readPowerEvents(options = {}) {
  const run = options.execute || execute;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { stdout } = await run("/bin/sh", ["-c", "/usr/bin/pmset -g log | /usr/bin/tail -n 1500"],
        { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
      // Raw power logs may name unrelated apps; return only event types/times.
      return parsePowerEvents(stdout);
    } catch (error) {
      // A timeout scheduled before hardware sleep can fire immediately on wake.
      // Retry only that bounded read; never fabricate events or replay work.
      if (attempt === 2 || !error.killed || error.signal !== "SIGTERM") throw error;
    }
  }
}
