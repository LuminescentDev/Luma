import { useEffect, useState } from "react";
import { Modal } from "../../components/Modal";
import { TextField } from "../hosts/fields";
import { useSnippetRunStore } from "../../stores/snippetRunStore";

/*
 * Mounted once in Layout. When a snippet with variables is requested, it prompts
 * for each {{variable}} before substituting and writing into the focused
 * terminal. Snippets without variables skip the dialog entirely.
 */
export function SnippetRunner() {
  const pending = useSnippetRunStore((s) => s.pending);
  const submit = useSnippetRunStore((s) => s.submit);
  const cancel = useSnippetRunStore((s) => s.cancel);

  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    if (pending) {
      setValues(Object.fromEntries(pending.variables.map((name) => [name, ""])));
    }
  }, [pending]);

  if (!pending) return null;

  const onSubmit = () => submit(values);
  const label = pending.mode === "run" ? "Run" : "Insert";

  return (
    <Modal
      open
      onOpenChange={(open) => !open && cancel()}
      title={`${label}: ${pending.snippet.name}`}
      description="Provide values for the snippet variables."
      footer={
        <>
          <button
            type="button"
            onClick={cancel}
            className="rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground hover:brightness-110"
          >
            {label}
          </button>
        </>
      }
    >
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        {pending.variables.map((name) => (
          <TextField
            key={name}
            label={name}
            value={values[name] ?? ""}
            onChange={(value) => setValues((prev) => ({ ...prev, [name]: value }))}
            placeholder={`Value for {{${name}}}`}
            mono
          />
        ))}
        <button type="submit" className="hidden" aria-hidden />
      </form>
    </Modal>
  );
}
