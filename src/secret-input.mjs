export function readSecret(prompt, options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    return Promise.reject(new Error("Enter the bot token in an interactive terminal; do not put secrets in command arguments or chat."));
  }
  return new Promise((resolve, reject) => {
    const wasRaw = Boolean(input.isRaw);
    let value = "";
    let escape = "";
    let finished = false;
    const done = (error) => {
      if (finished) return;
      finished = true;
      input.off("data", data);
      input.off("end", end);
      input.off("error", end);
      input.setRawMode(wasRaw);
      input.pause();
      output.write("\n");
      if (error) { value = ""; reject(error); } else resolve(value.trim());
    };
    const end = () => done(new Error("Secret input ended before submission."));
    const data = (chunk) => {
      for (const char of chunk.toString("utf8")) {
        if (escape) {
          escape += char;
          if (/^\x1b\[[0-9;?]*[A-Za-z~]$/.test(escape) || escape.length > 32) escape = "";
          continue;
        }
        if (char === "\x1b") { escape = char; continue; }
        if (["\x03", "\x04"].includes(char)) return done(new Error("Secret input cancelled."));
        if (["\r", "\n"].includes(char)) return done();
        if (["\x7f", "\b"].includes(char)) { value = value.slice(0, -1); continue; }
        if (!/[A-Za-z0-9_:-]/.test(char)) return done(new Error("Invalid token input. Paste only the bot token."));
        if (value.length >= 256) return done(new Error("Token input is too long."));
        value += char;
      }
    };
    output.write(`${prompt} (hidden): `);
    input.setRawMode(true);
    input.on("data", data);
    input.once("end", end);
    input.once("error", end);
    input.resume();
  });
}
