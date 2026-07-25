/*
 * Heuristic for recognizing a quick-connect target typed into the command
 * palette / new-tab launcher. Deliberately conservative: a plain search word
 * ("split", "hosts") must NOT be treated as a connection string, so beyond the
 * structural shape we require a strong signal (an ssh:// scheme, a user@ prefix,
 * a dot/colon, or a bracketed IPv6 literal). The actual parsing/validation is
 * done by the backend (quick_connect_prepare); this only decides whether to
 * offer the "Connect to …" affordance.
 */

const SHAPE = /^(ssh:\/\/)?([^@\s]+@)?[\w.\-[\]:]+$/i;

/** Whether `input` looks enough like `[ssh://][user@]host[:port]` (bracketed
 * IPv6 allowed) to surface a quick-connect action. */
export function looksLikeConnectionString(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  if (!SHAPE.test(trimmed)) return false;
  return (
    /^ssh:\/\//i.test(trimmed) || // explicit scheme
    trimmed.includes("@") || // user@host
    trimmed.startsWith("[") || // [ipv6]
    /[.:]/.test(trimmed) // has a dot (fqdn/ipv4) or a port colon
  );
}
