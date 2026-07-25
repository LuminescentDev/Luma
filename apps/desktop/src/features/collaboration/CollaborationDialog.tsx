import { useEffect, useRef, useState } from "react";
import {
  Check,
  Copy,
  Link2,
  LogOut,
  RadioTower,
  Share2,
  ShieldAlert,
  UserPlus,
  Users,
} from "lucide-react";
import { Modal } from "../../components/Modal";
import { useCollabStore } from "../../stores/collabStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useUiStore } from "../../stores/uiStore";
import {
  collabCreateInvite,
  parseCollaborationError,
  parseJoinToken,
  type InvitedRoomRole,
} from "../../lib/collab";
import {
  addParticipant,
  createJoinLink,
  joinRoom,
  joinRoomByCapability,
  leaveRoom,
  startSharing,
  stopSharing,
} from "./collabClient";
import { ConnectionStatusBadge, ControlBadge, RolePill } from "./collabUi";
import { cn } from "../../lib/utils";

export function CollaborationDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const runtime = useCollabStore((s) => s.runtime);
  const auth = useCollabStore((s) => s.auth);
  const hydrate = useCollabStore((s) => s.hydrate);
  const openSettings = useUiStore((s) => s.openSettings);
  const collabIntent = useUiStore((s) => s.collabIntent);
  const signedIn = auth?.status === "signedIn";

  useEffect(() => {
    if (open) void hydrate();
  }, [open, hydrate]);

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Collaborate"
      description="Share a terminal end-to-end encrypted, or join one you were invited to."
      size="md"
    >
      {collabIntent?.error && (
        <p
          role="alert"
          className="mb-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger"
        >
          {collabIntent.error}
        </p>
      )}
      {!signedIn ? (
        <SignInPrompt
          pendingJoin={Boolean(collabIntent?.joinToken)}
          onOpenSettings={() => {
            openSettings();
            onOpenChange(false);
          }}
        />
      ) : runtime.mode === "hosting" ? (
        <HostingPanel />
      ) : runtime.mode === "viewing" ? (
        <ViewingPanel onLeft={() => onOpenChange(false)} />
      ) : (
        <IdlePanel onJoined={() => onOpenChange(false)} />
      )}
    </Modal>
  );
}

function SignInPrompt({
  pendingJoin,
  onOpenSettings,
}: {
  pendingJoin: boolean;
  onOpenSettings: () => void;
}) {
  return (
    <div className="space-y-3 text-sm text-muted">
      <p>
        {pendingJoin
          ? "Sign in to your collaboration account to join this shared terminal. It will connect automatically once you return."
          : "Sign in to your collaboration account before sharing or joining a terminal."}
      </p>
      <button
        type="button"
        onClick={onOpenSettings}
        className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground"
      >
        Open collaboration settings
      </button>
    </div>
  );
}

function IdlePanel({ onJoined }: { onJoined: () => void }) {
  const joinIntent = useUiStore((s) => s.collabIntent?.mode === "join");
  const [tab, setTab] = useState<"share" | "join">(joinIntent ? "join" : "share");
  return (
    <div className="space-y-4">
      <div className="flex gap-1 rounded-lg border border-border bg-surface p-1">
        <TabButton active={tab === "share"} onClick={() => setTab("share")} icon={Share2}>
          Share a terminal
        </TabButton>
        <TabButton active={tab === "join"} onClick={() => setTab("join")} icon={Users}>
          Join a terminal
        </TabButton>
      </div>
      {tab === "share" ? <StartSharing /> : <JoinFlow onJoined={onJoined} />}
    </div>
  );
}

function StartSharing() {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const session = useSessionStore((s) =>
    s.sessions.find((candidate) => candidate.id === s.activeSessionId),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canShare = Boolean(activeSessionId) && session?.status === "connected";

  const share = async () => {
    if (!activeSessionId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await startSharing(activeSessionId);
    } catch (e) {
      setError(parseCollaborationError(e).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        Share the active terminal
        {session ? (
          <>
            {" "}
            <span className="font-medium text-foreground">{session.title}</span>
          </>
        ) : null}
        . Its output is encrypted on this device and streamed to people you invite.
      </p>
      {!canShare && (
        <p className="rounded-md border border-border bg-background px-3 py-2 text-xs text-muted">
          Open and connect a terminal first, then reopen this dialog to share it.
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={() => void share()}
        disabled={!canShare || busy}
        className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-50"
      >
        <RadioTower size={14} /> {busy ? "Starting…" : "Start sharing"}
      </button>
    </div>
  );
}

function JoinFlow({ onJoined }: { onJoined: () => void }) {
  const [invite, setInvite] = useState<string | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [roomId, setRoomId] = useState("");
  const [joinBusy, setJoinBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const joinToken = useUiStore((s) => s.collabIntent?.joinToken ?? null);
  const clearCollabIntent = useUiStore((s) => s.clearCollabIntent);
  const autoRanRef = useRef(false);

  // Auto-redeem a pending capability link once, now that the account is signed
  // in (this panel only mounts when signed in). On success the runtime flips to
  // "viewing" and the dialog swaps to the viewing panel; on failure we surface
  // the message and clear the token so it does not retry.
  useEffect(() => {
    if (!joinToken || autoRanRef.current) return;
    autoRanRef.current = true;
    void (async () => {
      try {
        await joinRoomByCapability(parseJoinToken(joinToken));
        clearCollabIntent();
      } catch (e) {
        setError(parseCollaborationError(e).message);
        clearCollabIntent();
      }
    })();
  }, [joinToken, clearCollabIntent]);

  const generateInvite = async () => {
    if (inviteBusy) return;
    setInviteBusy(true);
    setError(null);
    try {
      const result = await collabCreateInvite();
      setInvite(result.token);
    } catch (e) {
      setError(parseCollaborationError(e).message);
    } finally {
      setInviteBusy(false);
    }
  };

  const join = async () => {
    if (!roomId.trim() || joinBusy) return;
    setJoinBusy(true);
    setError(null);
    try {
      await joinRoom(roomId.trim());
      onJoined();
    } catch (e) {
      setError(parseCollaborationError(e).message);
    } finally {
      setJoinBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <section className="space-y-2">
        <p className="text-sm font-medium">1. Send your invite to the host</p>
        <p className="text-xs text-muted">
          Generate an invite token and send it to the terminal's owner through a
          channel you trust. It contains your device's public keys — never a secret.
        </p>
        {invite ? (
          <CopyableToken label="Your invite token" value={invite} />
        ) : (
          <button
            type="button"
            onClick={() => void generateInvite()}
            disabled={inviteBusy}
            className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:text-foreground disabled:opacity-50"
          >
            <UserPlus size={14} /> {inviteBusy ? "Generating…" : "Generate invite token"}
          </button>
        )}
      </section>

      <section className="space-y-2 border-t border-border pt-4">
        <p className="text-sm font-medium">2. Join once the host adds you</p>
        <p className="text-xs text-muted">
          Paste the room reference the host gave you, then join.
        </p>
        <div className="flex gap-2">
          <input
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
            placeholder="Room reference"
            aria-label="Room reference"
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-xs outline-none focus:border-accent"
          />
          <button
            type="button"
            onClick={() => void join()}
            disabled={!roomId.trim() || joinBusy}
            className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-50"
          >
            {joinBusy ? "Joining…" : "Join"}
          </button>
        </div>
      </section>

      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function HostingPanel() {
  const runtime = useCollabStore((s) => s.runtime);
  const [token, setToken] = useState("");
  const [role, setRole] = useState<InvitedRoomRole>("viewer");
  const [addBusy, setAddBusy] = useState(false);
  const [stopBusy, setStopBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkRole, setLinkRole] = useState<InvitedRoomRole>("viewer");
  const [link, setLink] = useState<{ url: string; role: InvitedRoomRole } | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  const makeLink = async () => {
    if (linkBusy) return;
    setLinkBusy(true);
    setLinkError(null);
    try {
      setLink({ url: await createJoinLink(linkRole), role: linkRole });
    } catch (e) {
      setLinkError(parseCollaborationError(e).message);
    } finally {
      setLinkBusy(false);
    }
  };

  const add = async () => {
    if (!token.trim() || addBusy) return;
    setAddBusy(true);
    setError(null);
    try {
      await addParticipant(token.trim(), role);
      setToken("");
    } catch (e) {
      setError(parseCollaborationError(e).message);
    } finally {
      setAddBusy(false);
    }
  };

  const stop = async () => {
    if (stopBusy) return;
    setStopBusy(true);
    try {
      await stopSharing();
    } finally {
      setStopBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <RadioTower size={14} className="text-accent" /> Sharing this terminal
        </span>
        <ConnectionStatusBadge status={runtime.status} />
      </div>

      {runtime.roomId && (
        <CopyableToken label="Room reference (share with people you invite)" value={runtime.roomId} />
      )}

      <section className="space-y-2 border-t border-border pt-4">
        <p className="text-sm font-medium">Create join link</p>
        <p className="text-xs text-muted">
          Generate a link that lets someone join directly, without exchanging an
          invite token first.
        </p>
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted" htmlFor="collab-link-role">
            Access
          </label>
          <select
            id="collab-link-role"
            value={linkRole}
            onChange={(e) => setLinkRole(e.target.value as InvitedRoomRole)}
            className="rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none focus:border-accent"
          >
            <option value="viewer">Viewer (read-only)</option>
            <option value="controller">Controller (can type)</option>
          </select>
          <button
            type="button"
            onClick={() => void makeLink()}
            disabled={linkBusy}
            className="ml-auto flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:text-foreground disabled:opacity-50"
          >
            <Link2 size={14} /> {linkBusy ? "Creating…" : "Create join link"}
          </button>
        </div>
        {link && (
          <div className="space-y-1.5">
            <CopyableToken label="Join link" value={link.url} />
            <p className="flex items-start gap-1.5 text-xs text-amber-400">
              <ShieldAlert size={13} className="mt-px shrink-0" />
              Anyone with this link can{" "}
              {link.role === "controller" ? "control" : "view"} this session — share
              only with people you trust.
            </p>
          </div>
        )}
        {linkError && (
          <p role="alert" className="text-xs text-danger">
            {linkError}
          </p>
        )}
      </section>

      <section className="space-y-2 border-t border-border pt-4">
        <p className="text-sm font-medium">Add a participant</p>
        <p className="text-xs text-muted">
          Paste the invite token the person sent you and choose their access level.
        </p>
        <textarea
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Paste invite token"
          aria-label="Invite token"
          rows={2}
          className="w-full resize-none rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-[11px] outline-none focus:border-accent"
        />
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted" htmlFor="collab-role">
            Access
          </label>
          <select
            id="collab-role"
            value={role}
            onChange={(e) => setRole(e.target.value as InvitedRoomRole)}
            className="rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none focus:border-accent"
          >
            <option value="viewer">Viewer (read-only)</option>
            <option value="controller">Controller (can type)</option>
          </select>
          <button
            type="button"
            onClick={() => void add()}
            disabled={!token.trim() || addBusy}
            className="ml-auto flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-50"
          >
            <UserPlus size={14} /> {addBusy ? "Adding…" : "Add"}
          </button>
        </div>
      </section>

      <ParticipantList />

      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={() => void stop()}
        disabled={stopBusy}
        className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:text-danger disabled:opacity-50"
      >
        <LogOut size={14} /> {stopBusy ? "Stopping…" : "Stop sharing"}
      </button>
    </div>
  );
}

function ViewingPanel({ onLeft }: { onLeft: () => void }) {
  const runtime = useCollabStore((s) => s.runtime);
  const [busy, setBusy] = useState(false);

  const leave = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await leaveRoom();
      onLeft();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <Users size={14} className="text-accent" /> Viewing a shared terminal
        </span>
        <ConnectionStatusBadge status={runtime.status} />
      </div>
      <p className="text-xs text-muted">
        You joined as {runtime.role === "controller" ? "a controller" : "a viewer"}. The
        shared terminal is shown in the workspace.
      </p>
      <ParticipantList />
      <button
        type="button"
        onClick={() => void leave()}
        disabled={busy}
        className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:text-danger disabled:opacity-50"
      >
        <LogOut size={14} /> {busy ? "Leaving…" : "Leave"}
      </button>
    </div>
  );
}

function ParticipantList() {
  const runtime = useCollabStore((s) => s.runtime);
  const controlHolder = runtime.sharedTerminalId
    ? runtime.control[runtime.sharedTerminalId] ?? null
    : null;

  if (runtime.participants.length === 0) {
    return (
      <div className="rounded-md border border-border bg-background px-3 py-3 text-center text-xs text-muted">
        No one else has joined yet.
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted">Participants</p>
      <ul className="space-y-1">
        {runtime.participants.map((participant) => {
          const isSelf = participant.memberId === runtime.selfMemberId;
          const holdsControl = controlHolder !== null && controlHolder === participant.memberId;
          return (
            <li
              key={participant.connectionId}
              className="flex items-center gap-2 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm"
            >
              <span className="min-w-0 flex-1 truncate">
                {isSelf ? "You" : `Member ${participant.memberId.slice(0, 8)}`}
              </span>
              {holdsControl && <ControlBadge />}
              <RolePill role={participant.role} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon: Icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof Share2;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors",
        active ? "bg-raised text-accent shadow-glow" : "text-muted hover:text-foreground",
      )}
    >
      <Icon size={14} />
      {children}
    </button>
  );
}

function CopyableToken({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <div>
      <p className="mb-1 text-xs font-medium text-muted">{label}</p>
      <div className="flex items-stretch gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-[11px] text-foreground">
          {value}
        </code>
        <button
          type="button"
          aria-label={`Copy ${label}`}
          onClick={() =>
            void navigator.clipboard.writeText(value).then(() => setCopied(true))
          }
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 text-sm text-muted hover:text-foreground"
        >
          {copied ? <Check size={14} className="text-accent" /> : <Copy size={14} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
