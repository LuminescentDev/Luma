/**
 * Escape a string for use as a single argument in a POSIX shell command line.
 * The value is always wrapped in single quotes (simple and safe — nothing is
 * special inside single quotes) with embedded single quotes emitted as '\''.
 */
export function escapePosixShellArg(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}
