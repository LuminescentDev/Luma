/**
 * Small platform helpers so shortcut/label code uses the correct modifier per
 * OS: Cmd on macOS, Ctrl on Windows/Linux (BUILD_PLAN cross-platform note).
 */
export function isMac(): boolean {
  return navigator.userAgent.includes("Mac");
}

/** Whether the platform's primary modifier is held for this event. */
export function hasPlatformModifier(event: {
  metaKey: boolean;
  ctrlKey: boolean;
}): boolean {
  return isMac() ? event.metaKey : event.ctrlKey;
}
