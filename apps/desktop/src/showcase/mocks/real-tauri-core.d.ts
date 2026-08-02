/* `@luma-showcase/real-tauri-core` is an alias defined in showcase.vite.config.ts
 * that resolves to the genuine @tauri-apps/api/core. It exists so mocks/core.ts
 * can reach the real IPC without the mock alias catching its own import. */
declare module "@luma-showcase/real-tauri-core" {
  export * from "@tauri-apps/api/core";
}
