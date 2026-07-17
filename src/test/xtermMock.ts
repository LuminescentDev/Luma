/*
 * Headless stand-in for `@xterm/xterm`'s Terminal. terminalManager constructs a
 * Terminal per session and wires event handlers; tests only need the surface it
 * touches, with no real DOM renderer. Terminal bytes are still never routed
 * through React — this simply lets the manager run under jsdom.
 */
export class Terminal {
  cols = 80;
  rows = 24;
  element: HTMLElement | undefined = undefined;
  options: Record<string, unknown>;
  private dataHandlers: Array<(data: string) => void> = [];

  constructor(options: Record<string, unknown> = {}) {
    this.options = options;
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
}
