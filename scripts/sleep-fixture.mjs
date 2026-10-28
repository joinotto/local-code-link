export const SLEEP_TEST_COMMAND = "/bin/sleep 1800";
const command = SLEEP_TEST_COMMAND;
const shells = ["/bin/zsh", "/bin/bash", "/bin/sh"];

// Accept only this exact harmless command, optionally wrapped in a known shell.
// Do not parse arbitrary shell syntax or trust a trailing array element.
export function isBoundedSleepCommand(value) {
  if (Array.isArray(value)) {
    return value.length === 1 && value[0] === command
      || value.length === 3 && shells.includes(value[0])
        && ["-c", "-lc"].includes(value[1]) && value[2] === command;
  }
  return value === command || shells.some((shell) => ["-c", "-lc"].some((flag) =>
    value === `${shell} ${flag} '${command}'` || value === `${shell} ${flag} "${command}"`));
}
