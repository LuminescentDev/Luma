import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Layout } from "./Layout";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Layout />
    </QueryClientProvider>
  );
}
