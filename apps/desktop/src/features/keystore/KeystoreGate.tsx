import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { parseLumaError, setupKeystore, unlockKeystore, type KeystoreStatus } from "../../lib/hosts";

export function KeystoreGate({ status, onReady }: { status: KeystoreStatus; onReady: () => void }) {
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (status.configured) await unlockKeystore(password);
      else await setupKeystore(password, remember);
      onReady();
    } catch (e) {
      setError(parseLumaError(e).message);
    } finally {
      setBusy(false);
    }
  };
  return <div className="flex h-full items-center justify-center bg-background p-8"><div className="w-full max-w-md rounded-2xl border border-border bg-surface p-6"><div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-accent/15 text-accent"><ShieldCheck size={22}/></div><h1 className="text-xl font-semibold">{status.configured?"Unlock Luma keystore":"Create Luma keystore"}</h1><p className="mt-1 text-sm text-muted">{status.configured?"Enter your master password to access encrypted keys.":"Your private keys and passphrases will be encrypted on this device."}</p><label className="mt-5 block text-xs text-muted">Master password<input autoFocus type="password" value={password} onChange={e=>setPassword(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")void submit()}} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none focus:border-accent"/></label>{!status.configured&&<label className="mt-4 flex items-start gap-2 text-sm"><input type="checkbox" checked={remember} onChange={e=>setRemember(e.target.checked)} className="mt-1"/><span>Remember on this device<span className="block text-xs text-muted">Otherwise the keystore locks when Luma closes.</span></span></label>}{error&&<p className="mt-3 text-xs text-danger">{error}</p>}<button disabled={password.length<8||busy} onClick={()=>void submit()} className="mt-5 w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-accent-foreground disabled:opacity-40">{busy?"Please wait…":status.configured?"Unlock keystore":"Create keystore"}</button></div></div>;
}
