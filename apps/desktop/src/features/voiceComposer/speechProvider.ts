import { isMac } from "../../lib/platform";

/*
 * Pluggable transcription provider for the voice composer.
 *
 * THE HONEST SITUATION, because the UI has to say it out loud:
 *
 *  - The only speech engine reachable from a Tauri webview without shipping a
 *    new native dependency is the Web Speech API. Luma does NOT bundle an
 *    offline model (whisper.cpp, ONNX and friends are deliberately out of
 *    scope — they would add tens of megabytes of native code).
 *
 *  - On macOS and iOS the app runs in WKWebView, which does not expose
 *    SpeechRecognition to web content at all. There is therefore no dictation
 *    on Apple platforms, and the composer says so rather than pretending.
 *
 *  - On Windows the app runs in WebView2 (Chromium), where SpeechRecognition
 *    DOES exist — but classically it streams audio to the browser vendor's
 *    cloud service. That is at odds with Luma's local-first stance, which is
 *    why dictation is opt-in (default OFF) and why the settings toggle states
 *    plainly where the audio goes.
 *
 *  - Newer Chromium exposes a `processLocally` flag requesting on-device
 *    recognition. We feature-detect it and ask for it, but we cannot verify
 *    that the engine honours it, so we never claim it is on-device — and if
 *    the engine rejects the local-only request we retry over the cloud and
 *    surface a notice saying exactly that.
 *
 * Everything below is feature detection at runtime. No version sniffing, no
 * fabricated provider, no API-key field.
 */

/** Minimal shape of the Web Speech API pieces we touch. */
type RecognitionAlternative = { readonly transcript: string };
type RecognitionResult = {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: RecognitionAlternative;
};
type RecognitionResultList = {
  readonly length: number;
  readonly [index: number]: RecognitionResult;
};
type RecognitionEvent = {
  readonly resultIndex: number;
  readonly results: RecognitionResultList;
};
type RecognitionErrorEvent = { readonly error: string; readonly message?: string };

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  /** Chromium's on-device request flag; absent on engines without it. */
  processLocally?: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
};

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

export type SpeechSupport =
  | {
      available: true;
      engine: "web-speech";
      /**
       * The engine exposes an on-device mode we can ASK for. Not a guarantee
       * that recognition stays on the device.
       */
      canRequestOnDevice: boolean;
      /** Plain-language privacy statement, shown next to the settings toggle. */
      privacyNote: string;
    }
  | {
      available: false;
      /** Why there is no dictation here. */
      reason: string;
      privacyNote: string;
    };

function recognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const scope = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

function unavailableReason(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || isMac()) {
    return "Apple's WKWebView — the webview Luma runs in on macOS and iOS — does not expose a speech recognition API to app content.";
  }
  if (/Android/.test(ua)) {
    return "This Android webview does not expose a speech recognition API to app content.";
  }
  return "This platform's webview does not expose a speech recognition API.";
}

/**
 * What transcription, if any, is available right now. Pure feature detection —
 * safe to call on every render.
 */
export function detectSpeechSupport(): SpeechSupport {
  const ctor = recognitionCtor();
  if (!ctor) {
    return {
      available: false,
      reason: unavailableReason(),
      privacyNote:
        "Luma does not bundle an offline speech model, so there is no dictation on this platform. You can still type or paste a draft, review it, and send it.",
    };
  }

  const canRequestOnDevice = "processLocally" in ctor.prototype;
  return {
    available: true,
    engine: "web-speech",
    canRequestOnDevice,
    privacyNote: canRequestOnDevice
      ? "Luma asks this platform's speech engine to transcribe on-device. If no local model is installed the engine may transcribe in its vendor's cloud instead — the composer tells you when that happens."
      : "This platform's speech recognition uploads your audio to the browser vendor's cloud service to transcribe it. It is not on-device. Leave this off if that is not acceptable.",
  };
}

export type DictationCallbacks = {
  /** Best-guess text so far; replaced on every update. */
  onInterim: (text: string) => void;
  /** A settled chunk, to be appended to the draft. */
  onFinal: (text: string) => void;
  /** Non-fatal information the user must see (e.g. a cloud fallback). */
  onNotice: (message: string) => void;
  /** Dictation failed; it is over. */
  onError: (message: string) => void;
  /** Dictation ended for any reason, including a normal stop. */
  onEnd: () => void;
};

export type DictationSession = {
  /** Finish cleanly, keeping what has been transcribed. */
  stop: () => void;
  /** Give up and discard in-flight audio. */
  abort: () => void;
};

function describeError(code: string): string {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone access was denied. Grant it in your system settings to dictate.";
    case "audio-capture":
      return "No microphone was found.";
    case "no-speech":
      return "No speech was detected.";
    case "network":
      return "The speech service could not be reached.";
    case "language-not-supported":
      return "This language is not supported by the platform's speech engine.";
    default:
      return `Dictation stopped (${code}).`;
  }
}

/**
 * Start dictating. Returns null when no provider is available.
 *
 * When the engine advertises an on-device mode we request it first; if the
 * engine refuses before producing any text we retry once WITHOUT the flag and
 * announce the cloud fallback through `onNotice`, so the user is never
 * silently uploaded.
 */
export function startDictation(callbacks: DictationCallbacks): DictationSession | null {
  const ctor = recognitionCtor();
  if (!ctor) return null;

  const wantsOnDevice = "processLocally" in ctor.prototype;
  let recognition: SpeechRecognitionLike | null = null;
  let produced = false;
  let finished = false;
  let retriedOverCloud = false;
  let stoppedByUser = false;

  const finish = () => {
    if (finished) return;
    finished = true;
    callbacks.onEnd();
  };

  const launch = (requestOnDevice: boolean) => {
    const instance = new ctor();
    recognition = instance;
    instance.lang = navigator.language || "en-US";
    instance.continuous = true;
    instance.interimResults = true;
    instance.maxAlternatives = 1;
    if (requestOnDevice) instance.processLocally = true;

    instance.onresult = (event) => {
      let interim = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const text = result[0]?.transcript ?? "";
        if (!text) continue;
        produced = true;
        if (result.isFinal) callbacks.onFinal(text);
        else interim += text;
      }
      callbacks.onInterim(interim);
    };

    instance.onerror = (event) => {
      if (event.error === "aborted" || stoppedByUser) return;
      // The engine turned down an on-device-only request: fall back once, and
      // say so rather than quietly switching to the cloud.
      if (requestOnDevice && !produced && !retriedOverCloud) {
        retriedOverCloud = true;
        callbacks.onNotice(
          "On-device recognition was unavailable, so this dictation is being transcribed by the platform's cloud speech service.",
        );
        try {
          launch(false);
          return;
        } catch {
          // Fall through to the error path below.
        }
      }
      callbacks.onError(describeError(event.error));
      finish();
    };

    instance.onend = () => {
      // A fallback relaunch ends the previous instance; that is not the end of
      // the dictation.
      if (recognition !== instance) return;
      finish();
    };

    instance.start();
  };

  try {
    launch(wantsOnDevice);
  } catch (error) {
    if (wantsOnDevice) {
      // start() can reject the local-only request synchronously.
      try {
        retriedOverCloud = true;
        callbacks.onNotice(
          "On-device recognition was unavailable, so this dictation is being transcribed by the platform's cloud speech service.",
        );
        launch(false);
        return session();
      } catch {
        /* fall through */
      }
    }
    callbacks.onError(
      error instanceof Error ? error.message : "Dictation could not be started.",
    );
    return null;
  }

  function session(): DictationSession {
    return {
      stop: () => {
        stoppedByUser = true;
        try {
          recognition?.stop();
        } catch {
          finish();
        }
      },
      abort: () => {
        stoppedByUser = true;
        try {
          recognition?.abort();
        } catch {
          /* already gone */
        }
        finish();
      },
    };
  }

  return session();
}
