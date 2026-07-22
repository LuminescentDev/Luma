export type InvokeArgs = Record<string, unknown>;
export type InvokeHandler = (
  cmd: string,
  args: InvokeArgs,
) => unknown | Promise<unknown>;

let handler: InvokeHandler | null = null;

export function setInvokeHandler(fn: InvokeHandler): void {
  handler = fn;
}

export async function invoke<T = unknown>(
  cmd: string,
  args: InvokeArgs = {},
): Promise<T> {
  if (!handler) {
    console.warn(`[showcase] invoke before handler installed: ${cmd}`);
    return null as T;
  }
  return (await handler(cmd, args)) as T;
}

export class Channel<T = unknown> {
  onmessage: (message: T) => void = () => {};
}

export function transformCallback(
  callback?: (response: unknown) => void,
): number {
  void callback;
  return 0;
}

export function isTauri(): boolean {
  return false;
}
