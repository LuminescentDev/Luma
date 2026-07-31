import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CornerDownLeft,
  History,
  Info,
  Loader2,
  Mic,
  MicOff,
  Paperclip,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { Modal } from "../../components/Modal";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useSettings } from "../../hooks/useSettings";
import { useSessionStore } from "../../stores/sessionStore";
import { SETTING_KEYS } from "../../types";
import { classifyDraft, type DestructiveReport } from "../../lib/destructiveCommands";
import { parseLumaError } from "../../lib/hosts";
import { relativeTime } from "../../lib/relativeTime";
import {
  addVoiceHistory,
  clearVoiceHistory,
  deleteVoiceHistory,
  listVoiceHistory,
  type VoiceHistoryEntry,
  type VoiceSource,
} from "../../lib/voiceHistory";
import { cn } from "../../lib/utils";
import {
  canAttachFile,
  pickLocalFile,
  uploadAttachment,
} from "../terminal/attachFile";
import { terminalManager } from "../terminal/terminalManager";
import {
  detectSpeechSupport,
  startDictation,
  type DictationSession,
} from "./speechProvider";

/*
 * Reviewed voice composer.
 *
 * The whole point is that dictation produces a DRAFT, never keystrokes in a
 * live shell. Speech, typing and attachments all land in the same textarea; the
 * user reads it, edits it, and only then chooses how it reaches the session:
 *
 *   - "Insert at prompt" (default) types the draft with no newline, exactly the
 *     paste-style path used by "Attach file" and the repository browser. The
 *     shell does not run it until the user presses Enter themselves.
 *   - "Send with Enter" appends \r and actually executes. When the draft trips
 *     the destructive-command classifier at "danger" this path is gated behind
 *     an explicit confirmation naming what matched.
 *
 * Auto-send after dictation exists because the backlog asked for it, but it is
 * off by default and only ever performs the safe insert — never Enter.
 */

type SendMode = "insert" | "enter";

/** Press longer than this and releasing stops dictation (hold-to-talk); shorter
 * and it latches on (click-to-toggle). */
const HOLD_MS = 350;

export function VoiceComposerDialog({
  open,
  onOpenChange,
  sessionId,
  label,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string | null;
  label?: string;
}) {
  const session = useSessionStore((s) =>
    s.sessions.find((candidate) => candidate.id === sessionId),
  );
  const { data: settings } = useSettings();

  // Both default OFF; dictation because it may be cloud-backed, auto-send
  // because it skips the review this feature exists to provide.
  const dictationEnabled = settings?.[SETTING_KEYS.voiceDictation] === true;
  const autoSendEnabled = settings?.[SETTING_KEYS.voiceAutoSend] === true;

  const [draft, setDraft] = useState("");
  const [interim, setInterim] = useState("");
  const [listening, setListening] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<VoiceHistoryEntry[]>([]);
  const [confirmMode, setConfirmMode] = useState<SendMode | null>(null);
  const [clearConfirm, setClearConfirm] = useState(false);
  /** Whether any of the current draft came from speech, for the history label. */
  const [dictated, setDictated] = useState(false);
  /** Whether the user hand-edited the draft, which turns "dictated" into "mixed". */
  const [edited, setEdited] = useState(false);

  const dictationRef = useRef<DictationSession | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  /** Set while auto-send is finishing a dictation, to avoid a double send. */
  const autoSendPending = useRef(false);
  /** When the push-to-talk button went down, to tell a hold from a click. */
  const pressStartedAt = useRef<number | null>(null);

  const support = useMemo(() => detectSpeechSupport(), []);
  const canDictate = support.available && dictationEnabled;
  const report: DestructiveReport = useMemo(() => classifyDraft(draft), [draft]);
  const attachable = canAttachFile(session);

  const refreshHistory = useCallback(() => {
    listVoiceHistory(50)
      .then(setHistory)
      .catch(() => {
        /* history is a convenience; a read failure must not break sending */
      });
  }, []);

  // Reset everything when the dialog opens on a session.
  useEffect(() => {
    if (!open) return;
    setDraft("");
    setInterim("");
    setNotice(null);
    setError(null);
    setDictated(false);
    setEdited(false);
    setConfirmMode(null);
    // Must be cleared here too: this effect's sibling below sees the PREVIOUS
    // render's draft, so a stale pending flag would send last session's text.
    autoSendPending.current = false;
    refreshHistory();
  }, [open, sessionId, refreshHistory]);

  const stopDictation = useCallback(() => {
    dictationRef.current?.stop();
    dictationRef.current = null;
    setListening(false);
    setInterim("");
  }, []);

  // Never leave the microphone open behind a closed dialog. Aborting fires
  // onEnd, which would otherwise arm auto-send for the next time it opens.
  useEffect(() => {
    if (open) return;
    dictationRef.current?.abort();
    dictationRef.current = null;
    autoSendPending.current = false;
    setListening(false);
    setInterim("");
  }, [open]);
  useEffect(
    () => () => {
      dictationRef.current?.abort();
      dictationRef.current = null;
    },
    [],
  );

  const appendFinal = useCallback((text: string) => {
    const chunk = text.trim();
    if (!chunk) return;
    setDictated(true);
    setDraft((current) =>
      current && !/\s$/.test(current) ? `${current} ${chunk}` : `${current}${chunk}`,
    );
  }, []);

  const beginDictation = useCallback(() => {
    if (!canDictate || dictationRef.current) return;
    setError(null);
    const started = startDictation({
      onInterim: setInterim,
      onFinal: appendFinal,
      onNotice: setNotice,
      onError: (message) => {
        setError(message);
        dictationRef.current = null;
        setListening(false);
        setInterim("");
      },
      onEnd: () => {
        dictationRef.current = null;
        setListening(false);
        setInterim("");
        if (autoSendEnabled) autoSendPending.current = true;
      },
    });
    if (!started) {
      setError("Dictation could not be started on this platform.");
      return;
    }
    dictationRef.current = started;
    setListening(true);
  }, [appendFinal, autoSendEnabled, canDictate]);

  const toggleDictation = useCallback(() => {
    if (listening) stopDictation();
    else beginDictation();
  }, [beginDictation, listening, stopDictation]);

  const recordHistory = useCallback(
    (text: string) => {
      const source: VoiceSource = !dictated ? "typed" : edited ? "mixed" : "dictated";
      addVoiceHistory(text, source)
        .then(() => refreshHistory())
        .catch(() => {
          /* history is best-effort; the send already happened */
        });
    },
    [dictated, edited, refreshHistory],
  );

  const performSend = useCallback(
    (mode: SendMode) => {
      const text = draft.trim();
      if (!sessionId || !text) return;
      if (mode === "enter") {
        // sendInput is the execute path; insertText is paste-style and inert.
        terminalManager.sendInput(sessionId, `${text}\r`);
      } else {
        terminalManager.insertText(sessionId, text);
      }
      recordHistory(text);
      onOpenChange(false);
    },
    [draft, onOpenChange, recordHistory, sessionId],
  );

  const requestSend = useCallback(
    (mode: SendMode) => {
      if (!draft.trim()) return;
      // Executing a flagged draft always needs a second, deliberate click.
      // "warn" counts: `rm -r`, `chmod 777`, `git push --force` and truncating
      // redirects are all irreversible enough that a banner alone is too easy
      // to send past — especially for a dictated draft the user did not type.
      if (mode === "enter" && report.level !== "none") {
        setConfirmMode(mode);
        return;
      }
      performSend(mode);
    },
    [draft, performSend, report.level],
  );

  // Auto-send (opt-in) fires once dictation settles, and only ever inserts.
  useEffect(() => {
    if (!autoSendPending.current || listening) return;
    autoSendPending.current = false;
    if (!autoSendEnabled || !draft.trim()) return;
    performSend("insert");
  }, [autoSendEnabled, draft, listening, performSend]);

  const attach = useCallback(async () => {
    if (!session) return;
    const picked = await pickLocalFile();
    if (picked === null) return;
    setUploading(true);
    setError(null);
    try {
      const escapedPath = await uploadAttachment(session, picked);
      setDraft((current) =>
        current && !/\s$/.test(current)
          ? `${current} ${escapedPath} `
          : `${current}${escapedPath} `,
      );
      textareaRef.current?.focus();
    } catch (uploadError) {
      setError(`Attachment upload failed: ${parseLumaError(uploadError).message}`);
    } finally {
      setUploading(false);
    }
  }, [session]);

  if (!sessionId) return null;

  const connected = session?.status === "connected";
  const trimmed = draft.trim();
  const preview = interim ? `${draft}${draft && !/\s$/.test(draft) ? " " : ""}${interim}` : draft;

  return (
    <>
      <Modal
        open={open}
        onOpenChange={onOpenChange}
        title="Voice composer"
        description={
          label ? `Compose a command for ${label}` : "Compose a command for this session"
        }
        size="lg"
        footer={
          <>
            <button
              type="button"
              onClick={() => setHistoryOpen((value) => !value)}
              className="mr-auto flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:border-accent hover:text-accent"
            >
              <History size={14} />
              {historyOpen ? "Hide history" : "History"}
            </button>
            <button
              type="button"
              disabled={!trimmed || !connected}
              onClick={() => requestSend("insert")}
              className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:border-accent hover:text-accent disabled:opacity-50"
            >
              Insert at prompt
            </button>
            <button
              type="button"
              disabled={!trimmed || !connected}
              onClick={() => requestSend("enter")}
              className={cn(
                "flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50",
                report.level === "danger"
                  ? "bg-danger text-white hover:brightness-110"
                  : "bg-accent text-accent-foreground",
              )}
            >
              <CornerDownLeft size={14} />
              Send with Enter
            </button>
          </>
        }
      >
        <div className="space-y-4">
          {!connected && (
            <p className="rounded-lg border border-border bg-background p-2.5 text-xs text-muted">
              This session is not connected. Reconnect before sending.
            </p>
          )}

          <div>
            <label
              htmlFor="voice-composer-draft"
              className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted"
            >
              Draft
            </label>
            <textarea
              id="voice-composer-draft"
              ref={textareaRef}
              value={preview}
              readOnly={listening}
              onChange={(event) => {
                setDraft(event.target.value);
                setEdited(true);
              }}
              rows={6}
              spellCheck={false}
              placeholder={
                canDictate
                  ? "Hold the microphone to dictate, or type here. Nothing is sent until you choose to send it."
                  : "Type or paste the command here. Nothing is sent until you choose to send it."
              }
              className="w-full resize-y rounded-lg border border-border bg-background p-3 font-mono text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
            />
            {listening && (
              <p className="mt-1 text-xs text-muted">
                Listening — the draft is read-only while dictating. Stop to edit.
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {support.available ? (
              dictationEnabled ? (
                <button
                  type="button"
                  // Hold-to-talk AND click-to-toggle from the same button:
                  // pressing starts, releasing stops only if it was a real hold
                  // (>= HOLD_MS). A quick click therefore latches it on, and the
                  // next click stops it. Keyboard activation produces a click
                  // with detail === 0 and no pointer events, so it toggles.
                  onPointerDown={() => {
                    if (listening) {
                      pressStartedAt.current = null;
                      stopDictation();
                      return;
                    }
                    pressStartedAt.current = Date.now();
                    beginDictation();
                  }}
                  onPointerUp={() => {
                    const startedAt = pressStartedAt.current;
                    pressStartedAt.current = null;
                    if (startedAt === null) return;
                    if (Date.now() - startedAt >= HOLD_MS) stopDictation();
                  }}
                  onClick={(event) => {
                    if (event.detail === 0) toggleDictation();
                  }}
                  aria-pressed={listening}
                  className={cn(
                    "flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium",
                    listening
                      ? "border-danger bg-danger/10 text-danger"
                      : "border-border text-foreground hover:border-accent hover:text-accent",
                  )}
                >
                  {listening ? <MicOff size={15} /> : <Mic size={15} />}
                  {listening ? "Stop dictating" : "Hold to dictate"}
                </button>
              ) : (
                <span className="flex items-center gap-2 text-xs text-muted">
                  <MicOff size={14} />
                  Dictation is off — enable it in Settings › Voice composer.
                </span>
              )
            ) : (
              <span className="flex items-start gap-2 text-xs text-muted">
                <Info size={14} className="mt-0.5 shrink-0" />
                <span>
                  On-device dictation is unavailable here. {support.reason}{" "}
                  {support.privacyNote}
                </span>
              </span>
            )}

            {attachable && (
              <button
                type="button"
                disabled={uploading || !connected}
                onClick={() => void attach()}
                className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:border-accent hover:text-accent disabled:opacity-50"
              >
                {uploading ? (
                  <Loader2 size={15} className="animate-spin" />
                ) : (
                  <Paperclip size={15} />
                )}
                Attach file…
              </button>
            )}
          </div>

          {notice && (
            <p className="rounded-lg border border-border bg-background p-2.5 text-xs text-muted">
              {notice}
            </p>
          )}
          {error && (
            <p className="rounded-lg border border-danger/40 bg-danger/10 p-2.5 text-xs text-danger">
              {error}
            </p>
          )}

          {report.level !== "none" && <SafetyBanner report={report} />}

          {historyOpen && (
            <HistoryPanel
              entries={history}
              onLoad={(entry) => {
                setDraft(entry.draft);
                setDictated(entry.source !== "typed");
                setEdited(entry.source === "mixed");
                setHistoryOpen(false);
                textareaRef.current?.focus();
              }}
              onDelete={(id) => {
                void deleteVoiceHistory(id)
                  .then(refreshHistory)
                  .catch(() => setError("Could not delete that entry."));
              }}
              onClear={() => setClearConfirm(true)}
            />
          )}
        </div>
      </Modal>

      {/* The execute gate. Names every pattern that fired, so the user is
          confirming something specific rather than a generic warning. */}
      <ConfirmDialog
        open={confirmMode !== null}
        onOpenChange={(value) => !value && setConfirmMode(null)}
        title={
          report.level === "danger"
            ? "Run a destructive command?"
            : "Run a risky command?"
        }
        destructive
        confirmLabel="Send with Enter"
        onConfirm={() => {
          const mode = confirmMode;
          setConfirmMode(null);
          if (mode) performSend(mode);
        }}
        message={
          <>
            <p>
              This draft will run immediately on{" "}
              <span className="font-medium text-foreground">{label ?? "this host"}</span>{" "}
              and matched:
            </p>
            <ul className="mt-2 space-y-1">
              {report.matches.map((match) => (
                <li key={`${match.label}-${match.snippet}`}>
                  <span className="font-medium text-foreground">{match.label}</span>
                  <code className="ml-1 break-all text-xs text-danger">
                    {match.snippet}
                  </code>
                </li>
              ))}
            </ul>
          </>
        }
      />

      <ConfirmDialog
        open={clearConfirm}
        onOpenChange={setClearConfirm}
        title="Clear draft history?"
        destructive
        confirmLabel="Clear history"
        onConfirm={() => {
          setClearConfirm(false);
          void clearVoiceHistory()
            .then(refreshHistory)
            .catch(() => setError("Could not clear history."));
        }}
        message="Every locally stored draft is deleted. This cannot be undone."
      />
    </>
  );
}

function SafetyBanner({ report }: { report: DestructiveReport }) {
  const danger = report.level === "danger";
  return (
    <div
      role="alert"
      className={cn(
        "rounded-lg border p-3",
        danger
          ? "border-danger/50 bg-danger/10"
          : "border-amber-500/50 bg-amber-500/10",
      )}
    >
      <p
        className={cn(
          "flex items-center gap-2 text-sm font-semibold",
          danger ? "text-danger" : "text-amber-400",
        )}
      >
        {danger ? <TriangleAlert size={15} /> : <AlertTriangle size={15} />}
        {danger
          ? "This draft looks destructive"
          : "This draft needs a second look"}
      </p>
      <ul className="mt-2 space-y-1">
        {report.matches.map((match) => (
          <li key={`${match.label}-${match.snippet}`} className="text-xs text-foreground">
            <span className="font-medium">{match.label}</span>
            <code className="ml-1.5 break-all text-muted">{match.snippet}</code>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-muted">
        Pattern matching only — it cannot understand the whole command. Read the
        draft before sending.
      </p>
    </div>
  );
}

const SOURCE_LABEL: Record<VoiceSource, string> = {
  typed: "Typed",
  dictated: "Dictated",
  mixed: "Dictated + edited",
};

function HistoryPanel({
  entries,
  onLoad,
  onDelete,
  onClear,
}: {
  entries: VoiceHistoryEntry[];
  onLoad: (entry: VoiceHistoryEntry) => void;
  onDelete: (id: number) => void;
  onClear: () => void;
}) {
  return (
    <section className="border-t border-border pt-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
          Recent drafts — this device only
        </h3>
        {entries.length > 0 && (
          <button
            type="button"
            onClick={onClear}
            className="text-xs text-muted hover:text-danger"
          >
            Clear history
          </button>
        )}
      </div>
      {entries.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted">
          Nothing yet. Drafts are recorded when you send them.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {entries.map((entry) => (
            <li key={entry.id} className="flex items-start gap-2">
              <button
                type="button"
                onClick={() => onLoad(entry)}
                title="Load this draft"
                className="min-w-0 flex-1 rounded-md border border-border bg-background p-2 text-left hover:border-accent"
              >
                <span className="block truncate font-mono text-xs text-foreground">
                  {entry.draft}
                </span>
                <span className="mt-0.5 block text-[11px] text-muted">
                  {SOURCE_LABEL[entry.source]} · {relativeTime(entry.createdAt * 1000)}
                </span>
              </button>
              <button
                type="button"
                aria-label="Delete this draft"
                title="Delete this draft"
                onClick={() => onDelete(entry.id)}
                className="mt-1 shrink-0 rounded-md p-1.5 text-muted hover:bg-raised hover:text-danger"
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
