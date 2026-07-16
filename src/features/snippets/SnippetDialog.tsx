import { useEffect, useState } from "react";
import { Modal } from "../../components/Modal";
import { SelectField, TextAreaField, TextField } from "../hosts/fields";
import { parseLumaError } from "../../lib/hosts";
import type { Snippet, SnippetInput } from "../../lib/snippets";
import { extractVariables } from "../../lib/snippets";
import type { Host } from "../../lib/hosts";

/*
 * Create / edit dialog for a snippet. Client-side validation mirrors the
 * backend rules (name 1-128, non-empty command <=8192 bytes, up to 32 variables
 * each matching [A-Za-z0-9_-] and 1-64 chars). Tags and variables are entered as
 * comma-separated lists.
 */

const VARIABLE_RE = /^[A-Za-z0-9_-]{1,64}$/;

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function SnippetDialog({
  open,
  onOpenChange,
  snippet,
  hosts,
  onSave,
  saving,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  snippet: Snippet | null;
  hosts: Host[];
  onSave: (input: SnippetInput) => Promise<void>;
  saving: boolean;
}) {
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [variables, setVariables] = useState("");
  const [hostId, setHostId] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(snippet?.name ?? "");
    setCommand(snippet?.command ?? "");
    setDescription(snippet?.description ?? "");
    setTags((snippet?.tags ?? []).join(", "));
    setVariables((snippet?.variables ?? []).join(", "));
    setHostId(snippet?.hostId ?? "");
    setErrors({});
    setSubmitError(null);
  }, [open, snippet]);

  const detected = extractVariables(command);

  const validate = (): SnippetInput | null => {
    const next: Record<string, string> = {};
    const trimmedName = name.trim();
    if (!trimmedName || trimmedName.length > 128) {
      next.name = "Name must be 1-128 characters.";
    }
    if (!command.trim()) {
      next.command = "Command is required.";
    } else if (new TextEncoder().encode(command).length > 8192) {
      next.command = "Command must be at most 8192 bytes.";
    }
    const variableList = splitList(variables);
    if (variableList.length > 32) {
      next.variables = "At most 32 variables.";
    } else if (variableList.some((v) => !VARIABLE_RE.test(v))) {
      next.variables =
        "Variables may only contain letters, digits, '_' or '-' (1-64 chars).";
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return null;
    return {
      name: trimmedName,
      command,
      description: description.trim() ? description.trim() : null,
      tags: splitList(tags),
      variables: variableList,
      hostId: hostId ? hostId : null,
    };
  };

  const submit = async () => {
    const input = validate();
    if (!input) return;
    try {
      await onSave(input);
      onOpenChange(false);
    } catch (error) {
      setSubmitError(parseLumaError(error).message);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={snippet ? "Edit snippet" : "New snippet"}
      size="lg"
      footer={
        <>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={saving}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground hover:brightness-110 disabled:opacity-50"
          >
            {snippet ? "Save" : "Create"}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <TextField
          label="Name"
          value={name}
          onChange={setName}
          placeholder="Restart service"
          required
          error={errors.name}
        />
        <TextAreaField
          label="Command"
          value={command}
          onChange={setCommand}
          placeholder="systemctl restart {{service}}"
          rows={5}
          mono
          required
          error={errors.command}
          hint="Use {{name}} for variables"
        />
        <TextField
          label="Description"
          value={description}
          onChange={setDescription}
          placeholder="Optional summary"
        />
        <div className="grid grid-cols-2 gap-3">
          <TextField
            label="Tags"
            value={tags}
            onChange={setTags}
            placeholder="deploy, ops"
            hint="Comma-separated"
          />
          <TextField
            label="Variables"
            value={variables}
            onChange={setVariables}
            placeholder="service, env"
            hint="Comma-separated"
            error={errors.variables}
          />
        </div>
        {detected.length > 0 && (
          <p className="text-xs text-muted">
            Detected in command:{" "}
            <span className="font-mono text-accent">
              {detected.map((v) => `{{${v}}}`).join(" ")}
            </span>
          </p>
        )}
        <SelectField
          label="Host association"
          value={hostId}
          onChange={setHostId}
        >
          <option value="">None (available everywhere)</option>
          {hosts.map((host) => (
            <option key={host.id} value={host.id}>
              {host.name}
            </option>
          ))}
        </SelectField>
        {submitError && <p className="text-sm text-danger">{submitError}</p>}
      </div>
    </Modal>
  );
}
