# Termius migration tools

`Export-TermiusVault.ps1` creates a read-only snapshot of the IndexedDB stores
used by Termius Desktop on Windows. It does not stop Termius, accept a vault
password, modify the Termius profile, or print record values.

Close Termius completely, then run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\Export-TermiusVault.ps1
```

Unlock Termius in the window opened by the script and return to PowerShell when
prompted. The resulting `termius-vault-export.json` is restricted to the current
Windows account. Treat it as a secret: depending on the Termius vault mode, it
can contain encrypted or locally available credential and private-key material.

The snapshot is an intermediate migration bundle. Import into Luma should only
be performed after the bundle passes schema validation and an item-count preview.
