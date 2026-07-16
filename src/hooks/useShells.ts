import { useQuery } from "@tanstack/react-query";
import { detectShells, listProfiles } from "../lib/terminal";

export function useShells() {
  return useQuery({
    queryKey: ["shells"],
    queryFn: detectShells,
    staleTime: Infinity,
  });
}

export function useProfiles() {
  return useQuery({
    queryKey: ["profiles"],
    queryFn: listProfiles,
    staleTime: 30_000,
  });
}
