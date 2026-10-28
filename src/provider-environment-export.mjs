import { providerValues } from "./provider-environment.mjs";

// Internal pipe protocol only. The parent captures this output in memory.
const nonce = process.argv[2];
if (!/^LCL_ENV_[0-9a-f-]{36}=$/.test(nonce || "")) {
  console.error("Internal provider environment export requires a capture nonce.");
  process.exitCode = 1;
} else {
  process.stdout.write(`${nonce}${JSON.stringify(providerValues(process.env))}\n`);
}
