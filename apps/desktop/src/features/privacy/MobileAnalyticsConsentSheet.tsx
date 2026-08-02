import { AnalyticsDisclosure } from "./AnalyticsDisclosure";
import { useAnalyticsConsent } from "./useAnalyticsConsent";

/*
 * Mobile first-run analytics consent. Mirrors MobileFontSizeSetup's bottom
 * sheet, with no dismiss affordance and no backdrop tap handler — see
 * AnalyticsConsentDialog for why the prompt is not dismissible.
 */
export function MobileAnalyticsConsentSheet() {
  const { shouldPrompt, choose } = useAnalyticsConsent();

  if (!shouldPrompt) return null;

  return (
    <div
      className="fixed inset-0 z-100 flex items-end bg-black/60 px-3 pb-safe backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="analytics-consent-title"
    >
      <div className="mb-3 max-h-[85vh] w-full overflow-y-auto rounded-2xl border border-border bg-surface p-5 shadow-2xl">
        <h2 id="analytics-consent-title" className="text-lg font-semibold">
          Help improve Luma?
        </h2>
        <p className="mt-1 text-sm text-muted">
          You can change this at any time in Settings → Privacy.
        </p>

        <div className="mt-4">
          <AnalyticsDisclosure />
        </div>

        <button
          type="button"
          disabled={choose.isPending}
          onClick={() => choose.mutate(true)}
          className="mt-5 min-h-11 w-full rounded-lg bg-accent px-4 text-sm font-semibold text-accent-foreground disabled:opacity-50"
        >
          Share anonymous analytics
        </button>
        <button
          type="button"
          disabled={choose.isPending}
          onClick={() => choose.mutate(false)}
          className="mt-2 min-h-11 w-full rounded-lg border border-border px-4 text-sm font-semibold text-foreground disabled:opacity-50"
        >
          No thanks
        </button>
      </div>
    </div>
  );
}
