import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { terminalManager } from "./terminalManager";
import { useUiStore } from "../../stores/uiStore";

export function SearchBar({ sessionId }: { sessionId: string }) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const setOpen = useUiStore((s) => s.setTerminalSearchOpen);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const close = () => {
    terminalManager.clearSearch(sessionId);
    setOpen(false);
    terminalManager.focus(sessionId);
  };

  return (
    <div className="absolute right-3 top-2 z-10 flex items-center gap-1 rounded-lg border border-border bg-raised px-2 py-1.5 shadow-glow">
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          if (e.target.value) {
            terminalManager.findNext(sessionId, e.target.value, true);
          } else {
            terminalManager.clearSearch(sessionId);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && query) {
            if (e.shiftKey) terminalManager.findPrevious(sessionId, query);
            else terminalManager.findNext(sessionId, query);
          }
          if (e.key === "Escape") close();
        }}
        placeholder="Search terminal…"
        className="w-48 bg-transparent text-sm outline-none placeholder:text-muted"
      />
      <IconButton
        label="Previous match"
        onClick={() => query && terminalManager.findPrevious(sessionId, query)}
      >
        <ChevronUp size={14} />
      </IconButton>
      <IconButton
        label="Next match"
        onClick={() => query && terminalManager.findNext(sessionId, query)}
      >
        <ChevronDown size={14} />
      </IconButton>
      <IconButton label="Close search" onClick={close}>
        <X size={14} />
      </IconButton>
    </div>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="rounded p-1 text-muted hover:bg-surface hover:text-foreground"
    >
      {children}
    </button>
  );
}
