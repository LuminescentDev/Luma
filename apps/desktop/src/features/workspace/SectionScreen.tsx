import { ScrollText } from "lucide-react";
import type { SidebarSection } from "../../types";

const CONTENT = {
  logs: { title: "Logs", description: "Review connection history and session activity.", icon: ScrollText },
} as const;

export function SectionScreen({ section }: { section: Extract<SidebarSection, "logs"> }) {
  const item = CONTENT[section];
  const Icon = item.icon;
  return <div className="h-full overflow-y-auto bg-background"><div className="mx-auto max-w-6xl px-8 py-8"><div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-accent/15 text-accent"><Icon size={22} /></div><h1 className="text-2xl font-semibold tracking-tight">{item.title}</h1><p className="mt-1 text-sm text-muted">{item.description}</p><div className="mt-8 flex min-h-64 items-center justify-center rounded-xl border border-dashed border-border bg-surface/50 text-sm text-muted">{item.title} workspace coming soon</div></div></div>;
}
