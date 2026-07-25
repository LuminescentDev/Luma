export class WebglAddon {
  constructor() {
    throw new Error("[showcase] WebGL addon disabled for deterministic capture");
  }
  onContextLoss(): { dispose(): void } {
    return { dispose() {} };
  }
  activate(): void {}
  dispose(): void {}
}
