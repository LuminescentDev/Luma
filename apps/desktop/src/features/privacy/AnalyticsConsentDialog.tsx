import * as Dialog from "@radix-ui/react-dialog";

import { AnalyticsDisclosure } from "./AnalyticsDisclosure";
import { useAnalyticsConsent } from "./useAnalyticsConsent";

/*
 * First-run analytics consent, shown once per device.
 *
 * Built directly on Radix rather than components/Modal because this dialog must
 * not be dismissible: Modal always renders a close button and closes on Escape
 * and overlay click. A silently-dismissed prompt would need a third "asked but
 * undecided" state, and dismissing a default-on prompt is exactly the dark
 * pattern this feature has to avoid. Both answers are one click, and the two
 * buttons carry equal visual weight on purpose.
 */
export function AnalyticsConsentDialog() {
  const { shouldPrompt, choose } = useAnalyticsConsent();

  if (!shouldPrompt) return null;

  return (
    <Dialog.Root open>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm" />
        <Dialog.Content
          onEscapeKeyDown={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-glow focus:outline-none"
        >
          <div className="border-b border-border px-5 py-3.5">
            <Dialog.Title className="text-sm font-semibold text-foreground">
              Help improve Luma?
            </Dialog.Title>
            <Dialog.Description className="mt-0.5 text-xs text-muted">
              You can change this at any time in Settings → Privacy.
            </Dialog.Description>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <AnalyticsDisclosure />
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3.5">
            <button
              type="button"
              disabled={choose.isPending}
              onClick={() => choose.mutate(false)}
              className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-raised disabled:opacity-50"
            >
              No thanks
            </button>
            <button
              type="button"
              disabled={choose.isPending}
              onClick={() => choose.mutate(true)}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground hover:brightness-110 disabled:opacity-50"
            >
              Share anonymous analytics
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
