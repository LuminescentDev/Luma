import { useEffect, useState } from "react";

/**
 * Subscribe to a CSS media query. Used for LAYOUT decisions that must change the
 * rendered structure (not just styling) at a breakpoint — feature/platform
 * branches keep using the capability store.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia(query).matches,
  );

  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = () => setMatches(media.matches);
    onChange();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}
