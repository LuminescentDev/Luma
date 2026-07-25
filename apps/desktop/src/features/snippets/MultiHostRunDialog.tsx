import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, ServerCog, X } from "lucide-react";
import { Modal } from "../../components/Modal";
import { useHosts, useHostGroups } from "../../hooks/useHosts";
import { useSnippetHostRunStore } from "../../stores/snippetHostRunStore";
import type { Host } from "../../lib/hosts";
import { SnippetRunResults } from "./SnippetRunResults";
import { cn } from "../../lib/utils";

/*
 * Mounted once in Layout. Opened by the snippet runner ("Run on multiple
 * hosts…") with an already-rendered command. Walks three steps: pick hosts
 * (individual + group checkboxes), confirm (command + target list + timeout),
 * then live per-host results. All backend work is a Channel-streamed exec run;
 * nothing here touches terminalManager.
 */

const MAX_HOSTS = 50;
const MIN_TIMEOUT = 1;
const MAX_TIMEOUT = 600;
const DEFAULT_TIMEOUT = 60;

type Step = "select" | "confirm" | "results";

export function MultiHostRunDialog() {
  const request = useSnippetHostRunStore((s) => s.request);
  const close = useSnippetHostRunStore((s) => s.close);
  const start = useSnippetHostRunStore((s) => s.start);
  const cancel = useSnippetHostRunStore((s) => s.cancel);
  const rerunFailed = useSnippetHostRunStore((s) => s.rerunFailed);
  const hostsMap = useSnippetHostRunStore((s) => s.hosts);
  const hostIds = useSnippetHostRunStore((s) => s.hostIds);
  const running = useSnippetHostRunStore((s) => s.running);
  const launchError = useSnippetHostRunStore((s) => s.launchError);

  const { data: allHosts } = useHosts();
  const { data: groups } = useHostGroups();

  const [step, setStep] = useState<Step>("select");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [timeout, setTimeoutSecs] = useState(DEFAULT_TIMEOUT);

  const open = request !== null;

  // Reset the flow whenever the dialog opens for a new request.
  useEffect(() => {
    if (open) {
      setStep("select");
      setSelected(new Set());
      setTimeoutSecs(DEFAULT_TIMEOUT);
    }
  }, [open]);

  // Only saved (non-ephemeral) hosts are eligible targets.
  const hosts = useMemo(
    () => (allHosts ?? []).filter((h) => !h.isEphemeral),
    [allHosts],
  );
  const hostName = useMemo(() => {
    const map = new Map(hosts.map((h) => [h.id, h.name]));
    return (id: string) => map.get(id) ?? id;
  }, [hosts]);

  const orderedHosts = hostIds
    .map((id) => hostsMap[id])
    .filter((h): h is NonNullable<typeof h> => Boolean(h));
  const failedCount = orderedHosts.filter(
    (h) => h.status === "failed" || h.status === "cancelled" || h.status === "unsupported",
  ).length;
  const okCount = orderedHosts.filter((h) => h.status === "ok").length;

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const setGroup = (ids: string[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  const selectedCount = selected.size;
  const tooMany = selectedCount > MAX_HOSTS;
  const canRun = selectedCount > 0 && !tooMany;

  const beginRun = () => {
    void start([...selected], timeout);
    setStep("results");
  };

  const title =
    step === "select"
      ? "Run on multiple hosts"
      : step === "confirm"
        ? "Confirm run"
        : "Run results";

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o) close();
      }}
      title={title}
      description={request?.snippetName ? `Snippet: ${request.snippetName}` : undefined}
      size="lg"
      footer={
        step === "select" ? (
          <>
            <span className="mr-auto text-xs text-muted">
              {selectedCount} selected
              {tooMany && (
                <span className="text-danger"> · max {MAX_HOSTS}</span>
              )}
            </span>
            <button
              type="button"
              onClick={close}
              className="rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => setStep("confirm")}
              disabled={!canRun}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground hover:brightness-110 disabled:opacity-50"
            >
              Next
            </button>
          </>
        ) : step === "confirm" ? (
          <>
            <button
              type="button"
              onClick={() => setStep("select")}
              className="mr-auto rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:text-foreground"
            >
              Back
            </button>
            <button
              type="button"
              onClick={close}
              className="rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={beginRun}
              className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground hover:brightness-110"
            >
              <ServerCog size={14} /> Run on {selectedCount}{" "}
              {selectedCount === 1 ? "host" : "hosts"}
            </button>
          </>
        ) : (
          <>
            <span className="mr-auto text-xs text-muted">
              {okCount} ok · {failedCount} failed
            </span>
            {running ? (
              <button
                type="button"
                onClick={cancel}
                className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:text-danger"
              >
                <X size={14} /> Cancel run
              </button>
            ) : (
              failedCount > 0 && (
                <button
                  type="button"
                  onClick={() => void rerunFailed(timeout)}
                  className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:border-accent hover:text-accent"
                >
                  Re-run failed only
                </button>
              )
            )}
            <button
              type="button"
              onClick={close}
              disabled={running}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground hover:brightness-110 disabled:opacity-50"
            >
              Close
            </button>
          </>
        )
      }
    >
      {step === "select" && (
        <HostSelect
          hosts={hosts}
          groups={groups ?? []}
          selected={selected}
          onToggle={toggle}
          onToggleGroup={setGroup}
        />
      )}
      {step === "confirm" && (
        <ConfirmStep
          command={request?.command ?? ""}
          hostNames={[...selected].map(hostName)}
          timeout={timeout}
          onTimeout={setTimeoutSecs}
        />
      )}
      {step === "results" && (
        <div className="space-y-3">
          {launchError && (
            <p className="rounded-md border border-danger/40 bg-danger/5 px-3 py-2 text-xs text-danger">
              {launchError}
            </p>
          )}
          {running && (
            <p className="flex items-center gap-2 text-xs text-muted">
              <Loader2 size={13} className="animate-spin text-accent" /> Running on{" "}
              {orderedHosts.length} {orderedHosts.length === 1 ? "host" : "hosts"}…
            </p>
          )}
          <SnippetRunResults hosts={orderedHosts} hostName={hostName} />
        </div>
      )}
    </Modal>
  );
}

function HostSelect({
  hosts,
  groups,
  selected,
  onToggle,
  onToggleGroup,
}: {
  hosts: Host[];
  groups: { id: string; name: string }[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onToggleGroup: (ids: string[], on: boolean) => void;
}) {
  if (hosts.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted">
        No saved hosts to run on. Save a host first.
      </p>
    );
  }

  const grouped = groups
    .map((group) => ({
      group,
      members: hosts.filter((h) => h.groupId === group.id),
    }))
    .filter((g) => g.members.length > 0);
  const ungrouped = hosts.filter((h) => !h.groupId);

  return (
    <div className="space-y-4">
      {grouped.map(({ group, members }) => {
        const ids = members.map((m) => m.id);
        const allOn = ids.every((id) => selected.has(id));
        const someOn = ids.some((id) => selected.has(id));
        return (
          <div key={group.id}>
            <GroupCheckbox
              label={group.name}
              checked={allOn}
              indeterminate={someOn && !allOn}
              onChange={(on) => onToggleGroup(ids, on)}
            />
            <div className="mt-1 space-y-0.5 pl-5">
              {members.map((host) => (
                <HostCheckbox
                  key={host.id}
                  host={host}
                  checked={selected.has(host.id)}
                  onChange={() => onToggle(host.id)}
                />
              ))}
            </div>
          </div>
        );
      })}
      {ungrouped.length > 0 && (
        <div>
          {grouped.length > 0 && (
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">
              Ungrouped
            </div>
          )}
          <div className="space-y-0.5">
            {ungrouped.map((host) => (
              <HostCheckbox
                key={host.id}
                host={host}
                checked={selected.has(host.id)}
                onChange={() => onToggle(host.id)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function GroupCheckbox({
  label,
  checked,
  indeterminate,
  onChange,
}: {
  label: string;
  checked: boolean;
  indeterminate: boolean;
  onChange: (on: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
      <input
        ref={ref}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-border accent-accent"
      />
      <span>{label}</span>
    </label>
  );
}

function HostCheckbox({
  host,
  checked,
  onChange,
}: {
  host: Host;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-raised/50">
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="h-4 w-4 rounded border-border accent-accent"
      />
      {host.tabColor && (
        <span
          aria-hidden="true"
          className="h-3 w-1 shrink-0 rounded-full"
          style={{ backgroundColor: host.tabColor }}
        />
      )}
      <span className="min-w-0 flex-1 truncate">{host.name}</span>
      <span className="shrink-0 truncate font-mono text-[11px] text-muted">
        {host.hostname}
      </span>
    </label>
  );
}

function ConfirmStep({
  command,
  hostNames,
  timeout,
  onTimeout,
}: {
  command: string;
  hostNames: string[];
  timeout: number;
  onTimeout: (value: number) => void;
}) {
  return (
    <div className="space-y-4">
      <div>
        <div className="mb-1 text-xs font-medium text-muted">Command</div>
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background px-2.5 py-2 font-mono text-xs text-foreground/90">
          {command}
        </pre>
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-muted">
          Timeout (seconds)
        </label>
        <input
          type="number"
          value={timeout}
          min={MIN_TIMEOUT}
          max={MAX_TIMEOUT}
          onChange={(e) => {
            const next = Number(e.target.value);
            if (Number.isFinite(next) && next >= MIN_TIMEOUT && next <= MAX_TIMEOUT) {
              onTimeout(next);
            }
          }}
          className="w-32 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-accent"
        />
      </div>
      <div>
        <div className="mb-1 text-xs font-medium text-muted">
          Targets ({hostNames.length})
        </div>
        <div className="flex flex-wrap gap-1.5">
          {hostNames.map((name, i) => (
            <span
              key={`${name}-${i}`}
              className={cn(
                "rounded-full bg-raised px-2 py-0.5 text-xs text-foreground",
              )}
            >
              {name}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
