import { describe, it, expect, beforeEach, vi } from "vitest";
import { openUrl } from "@tauri-apps/plugin-opener";
import { setInvoke } from "../test/tauriMock";
import {
  useWebPreviewStore,
  selectPreviewsForHost,
} from "./webPreviewStore";
import type { WebPreview } from "../lib/webPreview";

const listener = {
  port: 5173,
  bindAddress: "127.0.0.1",
  pid: 42,
  process: "node",
  kind: "vite",
};

function preview(overrides: Partial<WebPreview> = {}): WebPreview {
  return {
    tunnelId: "tunnel-1",
    hostId: "host-1",
    localPort: 49152,
    port: 5173,
    remoteBind: "127.0.0.1",
    ...overrides,
  };
}

beforeEach(() => {
  useWebPreviewStore.setState({
    hostId: null,
    listeners: [],
    discovering: false,
    discoverError: null,
    previews: {},
    opening: {},
    openError: null,
  });
  vi.mocked(openUrl).mockClear();
  vi.mocked(openUrl).mockResolvedValue(undefined);
});

describe("web preview store", () => {
  it("discover stores listeners for the requested host", async () => {
    const seen: Record<string, unknown> = {};
    setInvoke((cmd, args) => {
      if (cmd === "web_preview_discover") {
        Object.assign(seen, args);
        return { listeners: [listener] };
      }
      throw new Error(`unexpected ${cmd}`);
    });

    await useWebPreviewStore.getState().discover("host-1");

    expect(seen).toEqual({ hostId: "host-1" });
    const state = useWebPreviewStore.getState();
    expect(state.discovering).toBe(false);
    expect(state.listeners).toEqual([listener]);
    expect(state.discoverError).toBeNull();
  });

  it("discover surfaces a failure without losing the dialog", async () => {
    setInvoke(() => {
      throw { category: "ssh-error", message: "host unreachable" };
    });

    await useWebPreviewStore.getState().discover("host-1");

    const state = useWebPreviewStore.getState();
    expect(state.discovering).toBe(false);
    expect(state.listeners).toEqual([]);
    expect(state.discoverError).toContain("host unreachable");
  });

  it("open creates a preview and launches the loopback URL in the browser", async () => {
    const seen: Record<string, unknown> = {};
    setInvoke((cmd, args) => {
      if (cmd === "web_preview_open") {
        Object.assign(seen, args);
        return preview();
      }
      throw new Error(`unexpected ${cmd}`);
    });

    const opened = await useWebPreviewStore
      .getState()
      .open("host-1", 5173, "127.0.0.1");

    expect(seen).toEqual({
      hostId: "host-1",
      port: 5173,
      remoteBind: "127.0.0.1",
    });
    expect(opened?.localPort).toBe(49152);
    expect(openUrl).toHaveBeenCalledWith("http://127.0.0.1:49152/");
    const state = useWebPreviewStore.getState();
    expect(state.previews["tunnel-1"]).toEqual(preview());
    // The in-flight marker must not leak once the request settles.
    expect(state.opening[5173]).toBeUndefined();
    expect(state.openError).toBeNull();
  });

  it("open passes a null remote bind when the port was entered manually", async () => {
    const seen: Record<string, unknown> = {};
    setInvoke((_cmd, args) => {
      Object.assign(seen, args);
      return preview({ port: 8080 });
    });

    await useWebPreviewStore.getState().open("host-1", 8080);

    expect(seen.remoteBind).toBeNull();
  });

  it("open records the error and clears the pending flag on failure", async () => {
    setInvoke(() => {
      throw { category: "invalid-input", message: "port must be non-zero" };
    });

    const opened = await useWebPreviewStore.getState().open("host-1", 5173);

    expect(opened).toBeNull();
    const state = useWebPreviewStore.getState();
    expect(state.openError).toContain("port must be non-zero");
    expect(state.opening[5173]).toBeUndefined();
    expect(state.previews).toEqual({});
  });

  it("keeps the tunnel when the browser handler fails", async () => {
    setInvoke(() => preview());
    vi.mocked(openUrl).mockRejectedValueOnce(new Error("no handler"));

    await useWebPreviewStore.getState().open("host-1", 5173);

    const state = useWebPreviewStore.getState();
    // The preview survives so the dialog can still show the copyable URL.
    expect(state.previews["tunnel-1"]).toBeDefined();
    expect(state.openError).toContain("Could not open the browser");
  });

  it("close stops the tunnel and drops the preview", async () => {
    useWebPreviewStore.setState({ previews: { "tunnel-1": preview() } });
    const seen: Record<string, unknown> = {};
    setInvoke((cmd, args) => {
      expect(cmd).toBe("web_preview_close");
      Object.assign(seen, args);
      return null;
    });

    await useWebPreviewStore.getState().close("tunnel-1");

    expect(seen).toEqual({ tunnelId: "tunnel-1" });
    expect(useWebPreviewStore.getState().previews).toEqual({});
  });

  it("close drops the preview even if the backend rejects", async () => {
    useWebPreviewStore.setState({ previews: { "tunnel-1": preview() } });
    setInvoke(() => {
      throw new Error("unknown tunnel");
    });

    await useWebPreviewStore.getState().close("tunnel-1");

    expect(useWebPreviewStore.getState().previews).toEqual({});
  });

  it("hydrate mirrors the backend's open previews", async () => {
    setInvoke((cmd) => {
      expect(cmd).toBe("web_previews_list");
      return [preview(), preview({ tunnelId: "tunnel-2", port: 3000 })];
    });

    await useWebPreviewStore.getState().hydrate();

    expect(Object.keys(useWebPreviewStore.getState().previews).sort()).toEqual([
      "tunnel-1",
      "tunnel-2",
    ]);
  });

  it("selects a host's previews sorted by remote port", () => {
    useWebPreviewStore.setState({
      previews: {
        "tunnel-1": preview(),
        "tunnel-2": preview({ tunnelId: "tunnel-2", port: 3000 }),
        "tunnel-3": preview({
          tunnelId: "tunnel-3",
          hostId: "host-2",
          port: 80,
        }),
      },
    });

    const forHost = selectPreviewsForHost(
      useWebPreviewStore.getState(),
      "host-1",
    );

    expect(forHost.map((p) => p.port)).toEqual([3000, 5173]);
  });
});
