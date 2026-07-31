/**
 * Escape a string for use as a single argument in a POSIX shell command line.
 * The value is always wrapped in single quotes (simple and safe — nothing is
 * special inside single quotes) with embedded single quotes emitted as '\''.
 */
export function escapePosixShellArg(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

/**
 * Characters that stand for themselves in every shell a Luma session can land
 * in — POSIX shells, fish, cmd.exe and PowerShell. Letters and digits of any
 * script qualify; whitespace, quotes, globs and expansion characters do not.
 */
const SHELL_NEUTRAL = /^[\p{L}\p{N}._\-/:@+,=]+$/u;

/**
 * Quote a remote path for insertion at a prompt, but only when it genuinely
 * needs it.
 *
 * Luma cannot know which shell is behind a session, and POSIX quoting is wrong
 * in some of them: `'\''` is not an escape in fish, and cmd.exe does not treat
 * single quotes as quoting at all. Remote attachment names are sanitized to a
 * literal character set precisely so this usually returns the path untouched;
 * the POSIX fallback covers the remainder (an unusual home directory), which is
 * correct for sh/bash/zsh.
 */
export function escapeRemotePathArg(path: string): string {
  return SHELL_NEUTRAL.test(path) ? path : escapePosixShellArg(path);
}
