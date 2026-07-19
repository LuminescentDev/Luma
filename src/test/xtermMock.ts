/*
 * Headless stand-in for `@xterm/xterm`'s Terminal. terminalManager constructs a
 * Terminal per session and wires event handlers; tests only need the surface it
 * touches, with no real DOM renderer. Terminal bytes are still never routed
 * through React — this simply lets the manager run under jsdom.
 */
/** Headless stand-in for xterm's IMarker. Tests set `markerLine` on the Terminal
 * before emitting an OSC so successive marks land on controllable lines. */
export class FakeMarker {
  isDisposed = false;
  private disposeHandlers: Array<() => void> = [];
  constructor(public line: number) {}
  onDispose(cb: () => void): { dispose(): void } {
    this.disposeHandlers.push(cb);
    return { dispose: () => {} };
  }
  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.line = -1;
    for (const cb of this.disposeHandlers) cb();
  }
}

/** Headless stand-in for xterm's IDecoration. */
class FakeDecoration {
  isDisposed = false;
  element: HTMLElement | undefined = undefined;
  constructor(public marker: FakeMarker) {}
  onRender(_cb: (element: HTMLElement) => void): { dispose(): void } {
    return { dispose: () => {} };
  }
  onDispose(_cb: () => void): { dispose(): void } {
    return { dispose: () => {} };
  }
  dispose(): void {
    this.isDisposed = true;
  }
}

export class Terminal {
  cols = 80;
  rows = 24;
  element: HTMLElement | undefined = undefined;
  options: Record<string, unknown>;
  private dataHandlers: Array<(data: string) => void> = [];

  /** Line the next registerMarker() lands on (tests bump this between OSCs). */
  markerLine = 0;
  /** OSC handlers registered via `parser.registerOscHandler`, keyed by ident. */
  oscHandlers = new Map<number, (data: string) => boolean | Promise<boolean>>();
  /** Every marker this terminal has minted (for disposal-driven tests). */
  markers: FakeMarker[] = [];
  /** Buffer line text keyed by absolute line index (tests seed via setLine). */
  lines = new Map<number, string>();
  /** Last line passed to scrollToLine(), or null. */
  scrolledTo: number | null = null;
  baseY = 0;
  viewportY = 0;

  constructor(options: Record<string, unknown> = {}) {
    this.options = options;
    createdTerminals.push(this);
  }

  get parser() {
    return {
      registerOscHandler: (
        ident: number,
        cb: (data: string) => boolean | Promise<boolean>,
      ) => {
        this.oscHandlers.set(ident, cb);
        return { dispose: () => this.oscHandlers.delete(ident) };
      },
      registerCsiHandler: () => ({ dispose() {} }),
      registerDcsHandler: () => ({ dispose() {} }),
      registerEscHandler: () => ({ dispose() {} }),
    };
  }

  get buffer() {
    return {
      active: {
        type: "normal" as const,
        baseY: this.baseY,
        viewportY: this.viewportY,
        cursorY: 0,
        cursorX: 0,
        length: this.baseY + this.rows,
        getLine: (y: number) => {
          const text = this.lines.get(y);
          if (text === undefined) return undefined;
          return {
            translateToString: (_trimRight?: boolean) => text,
          };
        },
      },
    };
  }

  registerMarker(offset = 0): FakeMarker {
    const marker = new FakeMarker(this.markerLine + offset);
    this.markers.push(marker);
    return marker;
  }

  registerDecoration(options: { marker: FakeMarker }): FakeDecoration {
    return new FakeDecoration(options.marker);
  }

  scrollToLine(line: number): void {
    this.scrolledTo = line;
  }

  loadAddon(_addon: unknown): void {}
  attachCustomKeyEventHandler(_handler: unknown): void {}
  onTitleChange(_cb: (title: string) => void): { dispose(): void } {
    return { dispose() {} };
  }
  onData(cb: (data: string) => void): { dispose(): void } {
    this.dataHandlers.push(cb);
    return { dispose() {} };
  }
  onResize(_cb: (size: { cols: number; rows: number }) => void): {
    dispose(): void;
  } {
    return { dispose() {} };
  }

  write(_data: unknown): void {}
  clear(): void {}
  reset(): void {}
  focus(): void {}
  dispose(): void {}
  open(_host: HTMLElement): void {}
  refresh(_start: number, _end: number): void {}
  hasSelection(): boolean {
    return false;
  }
  getSelection(): string {
    return "";
  }
  clearSelection(): void {}
  selectAll(): void {}
  paste(_text: string): void {}

  /** Test hook: simulate the user typing into the terminal. */
  emitData(data: string): void {
    for (const handler of this.dataHandlers) handler(data);
  }

  /** Test hook: fire a registered OSC handler as xterm's parser would. */
  emitOsc(ident: number, data: string): void {
    this.oscHandlers.get(ident)?.(data);
  }

  /** Test hook: seed a buffer line's text for output-extraction tests. */
  setLine(y: number, text: string): void {
    this.lines.set(y, text);
  }
}

/**
 * Every Terminal the manager has constructed, in creation order. Input and
 * broadcast tests use this to reach a specific session's terminal (created in a
 * known order) and simulate typing via emitData(), exercising the real onData
 * fan-out path rather than the snippet/sendInput lane.
 */
export const createdTerminals: Terminal[] = [];
