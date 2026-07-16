import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { KeyRound, Pencil, Plus, Trash2 } from "lucide-react";
import { Modal } from "../../components/Modal";
import { createIdentity, deleteIdentity, updateIdentity, type Identity, type KeyReference } from "../../lib/hosts";
import { useIdentities, useInvalidateHosts } from "../../hooks/useHosts";
import { SelectField, TextField } from "./fields";

type Draft = { id: string | null; name: string; username: string; keyId: string; password: string };
const blank = (): Draft => ({ id: null, name: "", username: "", keyId: "", password: "" });

export function IdentitiesDialog({ open, onOpenChange, keys, onManageKeys }: { open: boolean; onOpenChange: (v: boolean) => void; keys: KeyReference[]; onManageKeys: () => void }) {
  const { data = [] } = useIdentities();
  const invalidate = useInvalidateHosts();
  const [draft, setDraft] = useState<Draft | null>(null);
  const save = useMutation({ mutationFn: (d: Draft) => {
    const input = { name: d.name.trim(), username: d.username.trim(), keyId: d.keyId || null, password: d.password || null };
    return d.id ? updateIdentity(d.id, input) : createIdentity(input);
  }, onSuccess: () => { invalidate(); setDraft(null); } });
  const remove = useMutation({ mutationFn: deleteIdentity, onSuccess: invalidate });
  const edit = (i: Identity) => setDraft({ id: i.id, name: i.name, username: i.username, keyId: i.keyId ?? "", password: "" });
  return <Modal open={open} onOpenChange={onOpenChange} title="Keychain" description="Reusable credentials for your hosts. Passwords stay in your operating system credential store; private keys remain where you keep them." size="lg">
    <div className="space-y-3">
      <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
        <div><div className="text-sm font-medium">SSH keys</div><div className="text-xs text-muted">{keys.length} saved key reference{keys.length === 1 ? "" : "s"}</div></div>
        <button className="rounded-md border border-border px-2.5 py-1.5 text-xs hover:border-accent hover:text-accent" onClick={onManageKeys}>Manage keys</button>
      </div>
      <div className="pt-1 text-[11px] font-semibold uppercase tracking-wider text-muted">Identities</div>
      {data.map((i) => <div key={i.id} className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2">
        <KeyRound size={15} className="text-muted"/><div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{i.name}</div><div className="text-xs text-muted">{i.username} · {i.keyId ? "SSH key" : "No key"}{i.hasPassword ? " · saved password" : ""}</div></div>
        <button onClick={() => edit(i)} className="p-1 text-muted hover:text-foreground" aria-label={`Edit ${i.name}`}><Pencil size={14}/></button>
        <button onClick={() => remove.mutate(i.id)} className="p-1 text-muted hover:text-danger" aria-label={`Delete ${i.name}`}><Trash2 size={14}/></button>
      </div>)}
      {draft ? <div className="space-y-3 rounded-lg border border-accent/40 p-3">
        <div className="grid grid-cols-2 gap-3"><TextField label="Identity name" required value={draft.name} onChange={(name) => setDraft({...draft,name})}/><TextField label="Username" required mono value={draft.username} onChange={(username) => setDraft({...draft,username})}/></div>
        <SelectField label="SSH key (optional)" value={draft.keyId} onChange={(keyId) => setDraft({...draft,keyId})}><option value="">None</option>{keys.map(k => <option key={k.id} value={k.id}>{k.name}</option>)}</SelectField>
        <TextField label={draft.id ? "New password (leave blank to keep current)" : "Password (optional)"} type="password" value={draft.password} onChange={(password) => setDraft({...draft,password})}/>
        <div className="flex justify-end gap-2"><button className="rounded border border-border px-3 py-1.5 text-sm" onClick={() => setDraft(null)}>Cancel</button><button disabled={!draft.name.trim() || !draft.username.trim() || save.isPending} className="rounded bg-accent px-3 py-1.5 text-sm text-accent-foreground disabled:opacity-50" onClick={() => save.mutate(draft)}>Save identity</button></div>
      </div> : <button className="flex items-center gap-2 text-sm text-accent" onClick={() => setDraft(blank())}><Plus size={14}/> Add identity</button>}
      {save.isError && <p className="text-xs text-danger">Could not save identity: {String(save.error)}</p>}
    </div>
  </Modal>;
}
