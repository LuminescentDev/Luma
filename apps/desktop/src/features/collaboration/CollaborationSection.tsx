import { useEffect, useState } from "react";
import { Check, Users } from "lucide-react";
import {
  collabGetConfig,
  collabSetServerUrl,
  parseCollaborationError,
} from "../../lib/collab";
import { useCollabStore } from "../../stores/collabStore";

/*
 * Collaboration settings: the server URL and a usage hint. Sign-in lives under
 * Settings → Account — the same account authorizes sync and collaboration — so
 * this section only reflects the current status and never holds secrets.
 */
export function CollaborationSection() {
  const auth = useCollabStore((s) => s.auth);
  const refreshAuthStatus = useCollabStore((s) => s.refreshAuthStatus);
  const hydrate = useCollabStore((s) => s.hydrate);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const [serverUrl, setServerUrl] = useState("");
  const [serverDirty, setServerDirty] = useState(false);
  const [savingUrl, setSavingUrl] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);

  // Load the configured server URL once (and whenever the auth server changes).
  useEffect(() => {
    let cancelled = false;
    void collabGetConfig()
      .then((config) => {
        if (!cancelled && !serverDirty) setServerUrl(config.serverUrl);
      })
      .catch(() => {
        // Leave the field editable; the user can still set a URL.
      });
    return () => {
      cancelled = true;
    };
  }, [auth?.serverUrl, serverDirty]);

  const saveServerUrl = async () => {
    if (!serverUrl.trim() || savingUrl) return;
    setSavingUrl(true);
    setUrlError(null);
    try {
      const config = await collabSetServerUrl(serverUrl.trim());
      setServerUrl(config.serverUrl);
      setServerDirty(false);
      await refreshAuthStatus();
    } catch (error) {
      setUrlError(parseCollaborationError(error).message);
    } finally {
      setSavingUrl(false);
    }
  };

  const signedIn = auth?.status === "signedIn";

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-1.5 flex items-baseline justify-between gap-2">
          <span className="text-sm font-medium">Server URL</span>
          <span className="text-xs text-muted">HTTPS required.</span>
        </div>
        <div className="flex gap-2">
          <input
            value={serverUrl}
            onChange={(e) => {
              setServerUrl(e.target.value);
              setServerDirty(true);
            }}
            placeholder="https://collab.luma.bwmp.dev"
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted/60 focus:border-accent"
          />
          <button
            type="button"
            onClick={() => void saveServerUrl()}
            disabled={!serverUrl.trim() || savingUrl || !serverDirty}
            className="shrink-0 rounded-md border border-border bg-raised px-3 py-1.5 text-sm font-medium text-foreground hover:border-accent/60 hover:bg-surface disabled:opacity-50"
          >
            {savingUrl ? "Saving…" : "Save"}
          </button>
        </div>
        {urlError && (
          <p role="alert" className="mt-1.5 text-xs text-danger">
            {urlError}
          </p>
        )}
      </div>

      <div className="flex items-start gap-2 rounded-lg border border-border bg-background px-3 py-2.5 text-xs text-muted">
        {signedIn ? (
          <>
            <Check size={14} className="mt-0.5 shrink-0 text-accent" />
            Signed in. Shared terminals are end-to-end encrypted.
          </>
        ) : (
          <>
            <Users size={14} className="mt-0.5 shrink-0" />
            Sign in to your Luma account under Settings → Account to share and join
            collaborative terminals.
          </>
        )}
      </div>

      <p className="flex items-start gap-1.5 text-xs text-muted">
        <Users size={13} className="mt-0.5 shrink-0" />
        Use the collaboration button above the terminal tabs to share a terminal or
        join one you have been invited to.
      </p>
    </div>
  );
}
