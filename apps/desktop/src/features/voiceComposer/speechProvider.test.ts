import { afterEach, describe, expect, it, vi } from "vitest";
import { detectSpeechSupport, startDictation } from "./speechProvider";

/*
 * These tests pin the HONEST-REPORTING contract, which is the part of the
 * provider that must never regress: when no engine exists we say so, and when
 * one does we describe where the audio goes without overclaiming.
 *
 * jsdom exposes no SpeechRecognition, which is exactly the macOS/iOS WKWebView
 * situation, so the unavailable path is the default here.
 */

type Scope = Record<string, unknown>;

function installRecognition(ctor: unknown) {
  (window as unknown as Scope).SpeechRecognition = ctor;
}

afterEach(() => {
  delete (window as unknown as Scope).SpeechRecognition;
  delete (window as unknown as Scope).webkitSpeechRecognition;
  vi.restoreAllMocks();
});

describe("detectSpeechSupport", () => {
  it("reports unavailable, with a reason, when the webview has no engine", () => {
    const support = detectSpeechSupport();
    expect(support.available).toBe(false);
    if (support.available) throw new Error("unreachable");
    expect(support.reason).toBeTruthy();
    // The user must be told there is no dictation AND that they can still type.
    expect(support.privacyNote).toMatch(/does not bundle an offline speech model/i);
    expect(support.privacyNote).toMatch(/type or paste/i);
  });

  it("names the cloud plainly when the engine has no on-device mode", () => {
    class CloudOnly {}
    installRecognition(CloudOnly);

    const support = detectSpeechSupport();
    expect(support.available).toBe(true);
    if (!support.available) throw new Error("unreachable");
    expect(support.engine).toBe("web-speech");
    expect(support.canRequestOnDevice).toBe(false);
    expect(support.privacyNote).toMatch(/cloud/i);
    expect(support.privacyNote).toMatch(/not on-device/i);
  });

  it("does not promise on-device even when the engine advertises the mode", () => {
    class MaybeLocal {
      processLocally = false;
    }
    // The flag lives on the prototype for real implementations.
    (MaybeLocal.prototype as unknown as Scope).processLocally = false;
    installRecognition(MaybeLocal);

    const support = detectSpeechSupport();
    expect(support.available).toBe(true);
    if (!support.available) throw new Error("unreachable");
    expect(support.canRequestOnDevice).toBe(true);
    // "asks"/"may" — never a guarantee that audio stays on the machine.
    expect(support.privacyNote).toMatch(/asks/i);
    expect(support.privacyNote).toMatch(/may/i);
  });

  it("accepts the webkit-prefixed constructor too", () => {
    class Prefixed {}
    (window as unknown as Scope).webkitSpeechRecognition = Prefixed;
    expect(detectSpeechSupport().available).toBe(true);
  });
});

describe("startDictation", () => {
  it("returns null when there is no engine, rather than pretending", () => {
    const callbacks = {
      onInterim: vi.fn(),
      onFinal: vi.fn(),
      onNotice: vi.fn(),
      onError: vi.fn(),
      onEnd: vi.fn(),
    };
    expect(startDictation(callbacks)).toBeNull();
    // No fabricated transcript, no error spam.
    expect(callbacks.onFinal).not.toHaveBeenCalled();
    expect(callbacks.onInterim).not.toHaveBeenCalled();
  });

  it("separates interim from final results and stops cleanly", () => {
    const instances: FakeRecognition[] = [];
    class FakeRecognition {
      lang = "";
      continuous = false;
      interimResults = false;
      maxAlternatives = 0;
      onresult: ((event: unknown) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      stopped = false;
      constructor() {
        instances.push(this);
      }
      start() {}
      stop() {
        this.stopped = true;
        this.onend?.();
      }
      abort() {}
    }
    installRecognition(FakeRecognition);

    const callbacks = {
      onInterim: vi.fn(),
      onFinal: vi.fn(),
      onNotice: vi.fn(),
      onError: vi.fn(),
      onEnd: vi.fn(),
    };
    const session = startDictation(callbacks);
    expect(session).not.toBeNull();

    const engine = instances[0];
    expect(engine.continuous).toBe(true);
    expect(engine.interimResults).toBe(true);

    engine.onresult?.({
      resultIndex: 0,
      results: {
        length: 2,
        0: { isFinal: true, length: 1, 0: { transcript: "list files" } },
        1: { isFinal: false, length: 1, 0: { transcript: " in tmp" } },
      },
    });

    expect(callbacks.onFinal).toHaveBeenCalledWith("list files");
    expect(callbacks.onInterim).toHaveBeenLastCalledWith(" in tmp");

    session?.stop();
    expect(engine.stopped).toBe(true);
    expect(callbacks.onEnd).toHaveBeenCalledTimes(1);
  });

  it("announces the cloud fallback instead of silently switching", () => {
    const instances: FallbackRecognition[] = [];
    class FallbackRecognition {
      lang = "";
      continuous = false;
      interimResults = false;
      maxAlternatives = 0;
      processLocally = false;
      onresult: ((event: unknown) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      constructor() {
        instances.push(this);
      }
      start() {
        // The engine refuses an on-device-only request.
        if (this.processLocally) {
          queueMicrotask(() =>
            this.onerror?.({ error: "language-not-supported" }),
          );
        }
      }
      stop() {
        this.onend?.();
      }
      abort() {}
    }
    (FallbackRecognition.prototype as unknown as Scope).processLocally = false;
    installRecognition(FallbackRecognition);

    const callbacks = {
      onInterim: vi.fn(),
      onFinal: vi.fn(),
      onNotice: vi.fn(),
      onError: vi.fn(),
      onEnd: vi.fn(),
    };
    startDictation(callbacks);
    expect(instances[0].processLocally).toBe(true);

    return Promise.resolve().then(() => {
      // Retried on a second instance, WITHOUT the local flag, and said so.
      expect(callbacks.onNotice).toHaveBeenCalledTimes(1);
      expect(callbacks.onNotice.mock.calls[0][0]).toMatch(/cloud speech service/i);
      expect(instances).toHaveLength(2);
      expect(instances[1].processLocally).toBe(false);
      expect(callbacks.onError).not.toHaveBeenCalled();
    });
  });
});
