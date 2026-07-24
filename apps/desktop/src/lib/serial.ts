import { Channel, invoke } from "@tauri-apps/api/core";

/*
 * Serial-port session spawn wrapper. Mirrors spawnPty in src/lib/terminal.ts:
 * raw bytes arrive on a Tauri Channel and are handed straight to xterm.js via
 * terminalManager — they never pass through React state. Serial has no cols/rows
 * so there is no resize command (do not send one).
 */

export type SerialPortKind = "usb" | "bluetooth" | "pci" | "unknown";

export type SerialPortInfo = {
  path: string;
  kind: SerialPortKind;
};

export type SerialDataBits = 5 | 6 | 7 | 8;
export type SerialParity = "none" | "odd" | "even";
export type SerialStopBits = 1 | 2;
export type SerialFlowControl = "none" | "software" | "hardware";

/** Backend `serial_spawn` request. Enum strings are case-sensitive; optional
 * fields default to dataBits=8, parity="none", stopBits=1, flowControl="none".
 * `baudRate` is required and must be within 300..=4_000_000. */
export type SerialConfig = {
  path: string;
  baudRate: number;
  dataBits?: SerialDataBits;
  parity?: SerialParity;
  stopBits?: SerialStopBits;
  flowControl?: SerialFlowControl;
};

export type SerialSpawnResult = { sessionId: string; portName: string };

export const SERIAL_BAUD_MIN = 300;
export const SERIAL_BAUD_MAX = 4_000_000;

export const SERIAL_BAUD_PRESETS = [
  9600, 19200, 38400, 57600, 115200, 230400,
] as const;

/** List the serial ports the backend can see. */
export function listSerialPorts(): Promise<SerialPortInfo[]> {
  return invoke<SerialPortInfo[]>("serial_ports_list");
}

/** Spawn a serial session. `onData` receives raw bytes (ArrayBuffer/number[])
 * or already-decoded strings, decoded identically to spawnPty; `onExit` reports
 * a clean disconnect as null/0. */
export function spawnSerial(
  request: SerialConfig,
  onData: (data: Uint8Array | string) => void,
  onExit: (code: number | null) => void,
): Promise<SerialSpawnResult> {
  const dataChannel = new Channel<ArrayBuffer | number[] | string>();
  dataChannel.onmessage = (message) => {
    if (message instanceof ArrayBuffer) onData(new Uint8Array(message));
    else if (Array.isArray(message)) onData(new Uint8Array(message));
    else onData(message);
  };
  const exitChannel = new Channel<number | null>();
  exitChannel.onmessage = onExit;

  return invoke<SerialSpawnResult>("serial_spawn", {
    request: {
      path: request.path,
      baudRate: request.baudRate,
      dataBits: request.dataBits,
      parity: request.parity,
      stopBits: request.stopBits,
      flowControl: request.flowControl,
    },
    onData: dataChannel,
    onExit: exitChannel,
  });
}

/** Write UTF-8 text (keyboard input) to a serial session. Mirrors writePty. */
export function writeSerial(sessionId: string, data: string): Promise<void> {
  return invoke<void>("serial_write", { sessionId, data });
}

/** Close a serial session. Call on session disposal. Mirrors killPty. */
export function killSerial(sessionId: string): Promise<void> {
  return invoke<void>("serial_kill", { sessionId });
}
