import path from "node:path";
const xml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");

export function buildLaunchAgent({ projectRoot, stateRoot, configFile, providerBins = {}, nodeBin = process.execPath }) {
  const directories = [nodeBin, providerBins.codex, providerBins.claude]
    .filter((value) => value && path.isAbsolute(value)).map((value) => path.dirname(value));
  const environment = { PATH: [...new Set([...directories, "/opt/homebrew/bin",
    "/usr/local/bin", "/usr/bin", "/bin"])].join(":"),
  LOCAL_CODE_LINK_HOME: stateRoot, LOCAL_CODE_LINK_ENV_FILE: configFile };
  const entries = Object.entries(environment).filter(([, value]) => value !== undefined)
    .map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.local-code-link.telegram</string>
<key>ProgramArguments</key><array>
<string>${xml(nodeBin)}</string><string>${xml(path.join(projectRoot, "src", "cli.mjs"))}</string><string>serve</string>
</array>
<key>WorkingDirectory</key><string>${xml(projectRoot)}</string>
<key>EnvironmentVariables</key><dict>${entries}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${xml(path.join(stateRoot, "telegram.log"))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(stateRoot, "telegram-error.log"))}</string>
</dict></plist>
`;
}
