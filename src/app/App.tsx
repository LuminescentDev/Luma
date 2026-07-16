import { QueryClientProvider } from "@tanstack/react-query";
import { Layout } from "./Layout";
import { queryClient } from "../lib/queryClient";

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Layout />
    </QueryClientProvider>
  );
}
