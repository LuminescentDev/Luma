import { QueryClientProvider } from "@tanstack/react-query";
import { Layout } from "./Layout";
import { queryClient } from "../lib/queryClient";
import { DetachedTerminalWindow } from "../features/terminal/DetachedTerminalWindow";

export function App() {
  if (new URLSearchParams(location.search).has("detached")) {
    return <DetachedTerminalWindow />;
  }
  return (
    <QueryClientProvider client={queryClient}>
      <Layout />
    </QueryClientProvider>
  );
}
