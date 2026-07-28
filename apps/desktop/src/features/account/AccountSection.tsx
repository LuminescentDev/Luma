import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Loader2, UserRound } from "lucide-react";
import {
  collabAuthPoll,
  collabAuthSignOut,
  collabAuthStart,
  collabGetConfig,
  collabSetServerUrl,
  parseCollaborationError,
  type CollabAuthStart,
} from "../../lib/collab";
import { useCollabStore } from "../../stores/collabStore";

/*
 * The single Luma account. Both Luma Cloud sync and collaborative terminals
 * trust the same identity provider, so signing in here authorizes both. No
 * secrets are held in the frontend — the access token stays in the backend.
 */
export function AccountSection() {
  const auth = useCollabStore((s) => s.auth);
  const authError = useCollabStore((s) => s.authError);
  const refreshAuthStatus = useCollabStore((s) => s.refreshAuthStatus);
  const hydrate = useCollabStore((s) => s.hydrate);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const [serverUrl, setServerUrl] = useState("");
  const [serverDirty, setServerDirty] = useState(false);
  const [savingUrl, setSavingUrl] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);

  const [device, setDevice] = useState<CollabAuthStart | null>(null);
  const [busy, setBusy] = useState(false);
  const [flowError, setFlowError] = useState<string | null>(null);

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

  // Poll the device-code flow until it completes or is abandoned.
  useEffect(() => {
    if (!device) return;
    let cancelled = false;
    const timeout = window.setTimeout(async () => {
      try {
        const result = await collabAuthPoll();
        if (cancelled) return;
        if (result.status === "complete") {
          setDevice(null);
          setFlowError(null);
          await refreshAuthStatus();
        } else {
          setDevice((current) =>
            current
              ? {
                  ...current,
                  interval: result.retryAfterSeconds ?? current.interval,
                }
              : null,
          );
        }
      } catch (error) {
        if (!cancelled) {
          setDevice(null);
          setFlowError(parseCollaborationError(error).message);
        }
      }
    }, Math.max(1, device.interval) * 1000);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [device, refreshAuthStatus]);

  const saveServerUrl = async () => {
    if (!serverUrl.trim() || savingUrl) return;
    setSavingUrl(true);
    setUrlError(null);
    try {
      const config = await collabSetServerUrl(serverUrl.trim());
      setServerUrl(config.serverUrl);
      setServerDirty(false);
      setDevice(null); // changing the server cancels any pending login
      await refreshAuthStatus();
    } catch (error) {
      setUrlError(parseCollaborationError(error).message);
    } finally {
      setSavingUrl(false);
    }
  };

  const startSignIn = async () => {
    if (busy) return;
    setBusy(true);
    setFlowError(null);
    try {
      const started = await collabAuthStart();
      setDevice(started);
      await openUrl(started.verificationUriComplete ?? started.verificationUri);
    } catch (error) {
      setFlowError(parseCollaborationError(error).message);
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    if (busy) return;
    setBusy(true);
    setFlowError(null);
    try {
      await collabAuthSignOut();
      setDevice(null);
      await refreshAuthStatus();
    } catch (error) {
      setFlowError(parseCollaborationError(error).message);
    } finally {
      setBusy(false);
    }
  };

  const signedIn = auth?.status === "signedIn";
  const statusText =
    auth?.status === "signedIn"
      ? "Signed in. This account authorizes both sync and collaboration."
      : auth?.status === "pending"
        ? "Finish signing in through your browser."
        : auth?.status === "expired"
          ? "Your session expired — sign in again."
          : "Sign in once to use Luma Cloud sync and collaborative terminals.";

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-1.5 flex items-baseline justify-between gap-2">
          <span className="text-sm font-medium">Account server URL</span>
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

      <div className="rounded-lg border border-border bg-background p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-sm font-medium">
              <UserRound size={14} /> Luma account
            </p>
            <p className="mt-0.5 text-xs text-muted">{statusText}</p>
          </div>
          <button
            type="button"
            disabled={busy || !serverUrl.trim()}
            onClick={() => void (signedIn ? signOut() : startSignIn())}
            className="shrink-0 rounded-md border border-border bg-raised px-3 py-1.5 text-sm font-medium text-foreground hover:border-accent/60 hover:bg-surface disabled:opacity-50"
          >
            {busy ? "Please wait…" : signedIn ? "Sign out" : "Sign in"}
          </button>
        </div>

        {device && (
          <div className="mt-3 border-t border-border pt-3 text-xs text-muted">
            <p className="flex items-center gap-1.5">
              <Loader2 size={12} className="animate-spin text-accent" />
              Enter code{" "}
              <strong className="font-mono text-foreground">{device.userCode}</strong> in
              your browser to finish signing in.
            </p>
            <button
              type="button"
              onClick={() =>
                void openUrl(device.verificationUriComplete ?? device.verificationUri)
              }
              className="mt-2 text-accent hover:underline"
            >
              Reopen sign-in page
            </button>
          </div>
        )}

        {(flowError || authError) && (
          <p role="alert" className="mt-3 text-xs text-danger">
            {flowError ?? authError}
          </p>
        )}
      </div>
    </div>
  );
}
