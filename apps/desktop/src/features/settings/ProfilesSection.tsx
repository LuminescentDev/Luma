import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import {
  createProfile,
  deleteProfile,
  type ProfileInput,
  type TerminalProfile,
} from "../../lib/terminal";
import { useProfiles } from "../../hooks/useShells";

function splitArgs(raw: string): string[] {
  return raw
    .trim()
    .split(/\s+/)
    .filter((a) => a.length > 0);
}

export function ProfilesSection() {
  const { data: profiles } = useProfiles();
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["profiles"] });

  const create = useMutation({
    mutationFn: (input: ProfileInput) => createProfile(input),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteProfile(id),
    onSuccess: invalidate,
  });

  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [shellPath, setShellPath] = useState("");
  const [args, setArgs] = useState("");
  const [cwd, setCwd] = useState("");

  const submit = () => {
    create.mutate(
      {
        name,
        shellPath,
        args: splitArgs(args),
        workingDirectory: cwd.trim() || null,
      },
      {
        onSuccess: () => {
          setAdding(false);
          setName("");
          setShellPath("");
          setArgs("");
          setCwd("");
        },
      },
    );
  };

  return (
    <div className="space-y-3">
      {(profiles ?? []).length === 0 && !adding && (
        <p className="text-sm text-muted">
          No custom profiles. Profiles let you launch a shell with specific
          arguments, working directory, or environment.
        </p>
      )}

      {(profiles ?? []).map((profile: TerminalProfile) => (
        <div
          key={profile.id}
          className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2"
        >
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{profile.name}</p>
            <p className="truncate font-mono text-xs text-muted">
              {profile.shellPath} {profile.args.join(" ")}
            </p>
          </div>
          <button
            type="button"
            aria-label={`Delete profile ${profile.name}`}
            onClick={() => remove.mutate(profile.id)}
            className="shrink-0 rounded-md p-1.5 text-muted hover:bg-raised hover:text-danger"
          >
            <Trash2 size={15} />
          </button>
        </div>
      ))}

      {adding ? (
        <div className="space-y-2 rounded-lg border border-border bg-background p-3">
          <ProfileField label="Name" value={name} onChange={setName} placeholder="Dev shell" />
          <ProfileField
            label="Shell path"
            value={shellPath}
            onChange={setShellPath}
            placeholder="C:\\Program Files\\PowerShell\\7\\pwsh.exe"
            mono
          />
          <ProfileField
            label="Arguments"
            value={args}
            onChange={setArgs}
            placeholder="-NoLogo -NoExit"
            mono
          />
          <ProfileField
            label="Working directory (optional)"
            value={cwd}
            onChange={setCwd}
            placeholder="D:\\Projects"
            mono
          />
          {create.isError && (
            <p className="text-xs text-danger">
              {(create.error as { message?: string })?.message ?? "Failed to create profile."}
            </p>
          )}
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={submit}
              disabled={!name.trim() || !shellPath.trim() || create.isPending}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-50"
            >
              Save profile
            </button>
            <button
              type="button"
              onClick={() => setAdding(false)}
              className="rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="flex items-center gap-2 rounded-md border border-dashed border-border px-3 py-1.5 text-sm text-muted hover:border-accent hover:text-accent"
        >
          <Plus size={14} /> Add profile
        </button>
      )}
    </div>
  );
}

function ProfileField({
  label,
  value,
  onChange,
  placeholder,
  mono,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm outline-none placeholder:text-muted/60 focus:border-accent ${mono ? "font-mono" : ""}`}
      />
    </label>
  );
}
