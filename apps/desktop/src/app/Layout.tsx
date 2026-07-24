import { lazy, Suspense, useEffect } from "react";
import { useAppInit } from "./useAppInit";
import { DesktopLayout } from "./DesktopLayout";
import { useCapabilityStore } from "../stores/capabilityStore";

/*
 * Top-level shell dispatcher. All app-init wiring is shared via useAppInit; the
 * only branch here is which shell to render, decided SOLELY by the capability
 * store (never a user-agent check). The mobile shell is code-split so it never
 * ships in the desktop initial bundle.
 *
 * The capability store starts with a DESKTOP-shaped default (isMobile=false), so
 * until hydration resolves the desktop shell renders exactly as before — no
 * splash, no flash, desktop is byte-for-byte unchanged. On a phone, hydration is
 * a fast local invoke that flips isMobile=true and swaps in the mobile shell.
 */
const MobileLayout = lazy(() =>
  import("../features/mobile/MobileLayout").then((m) => ({
    default: m.MobileLayout,
  })),
);

/** Neutral background used only as the mobile chunk's Suspense fallback (matches
 * the app background, so it is invisible against the pre-paint). */
function ShellFallback() {
  return <div className="h-full w-full bg-background" aria-hidden="true" />;
}

export function Layout() {
  useAppInit();
  const isMobile = useCapabilityStore((s) => s.capabilities.isMobile);

  useEffect(() => {
    void useCapabilityStore.getState().hydrate();
  }, []);

  if (isMobile) {
    return (
      <Suspense fallback={<ShellFallback />}>
        <MobileLayout />
      </Suspense>
    );
  }
  return <DesktopLayout />;
}
