import { useEffect, useMemo, useState } from "react";
import { Cable, ChevronDown, ChevronUp, RefreshCw, Usb } from "lucide-react";
import { Modal } from "../../components/Modal";
import { useUiStore } from "../../stores/uiStore";
import { useSessionStore } from "../../stores/sessionStore";
import { parseLumaError } from "../../lib/hosts";
import {
  SERIAL_BAUD_MAX,
  SERIAL_BAUD_MIN,
  SERIAL_BAUD_PRESETS,
  listSerialPorts,
  type SerialConfig,
  type SerialDataBits,
  type SerialFlowControl,
  type SerialParity,
  type SerialPortInfo,
  type SerialStopBits,
} from "../../lib/serial";
import { cn } from "../../lib/utils";

const DATA_BITS: SerialDataBits[] = [5, 6, 7, 8];
const PARITIES: SerialParity[] = ["none", "odd", "even"];
const STOP_BITS: SerialStopBits[] = [1, 2];
const FLOW_CONTROLS: SerialFlowControl[] = ["none", "software", "hardware"];

/*
 * Serial-terminal connect surface. Populates a port dropdown from the backend,
 * offers common baud presets plus a custom numeric entry, and exposes the
 * advanced framing controls (data bits, parity, stop bits, flow control). On
 * connect it hands a SerialConfig to the session store; the resulting session's
 * bytes flow backend -> Channel -> xterm.js and never through React state.
 */
export function SerialConnectDialog() {
  const open = useUiStore((s) => s.serialConnectOpen);
  const closeSerialConnect = useUiStore((s) => s.closeSerialConnect);
  const openSerialSession = useSessionStore((s) => s.openSerialSession);

  const [ports, setPorts] = useState<SerialPortInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [path, setPath] = useState("");

  const [baud, setBaud] = useState<number>(115200);
  const [dataBits, setDataBits] = useState<SerialDataBits>(8);
  const [parity, setParity] = useState<SerialParity>("none");
  const [stopBits, setStopBits] = useState<SerialStopBits>(1);
  const [flowControl, setFlowControl] = useState<SerialFlowControl>("none");
  const [showAdvanced, setShowAdvanced] = useState(false);

  const refresh = useMemo(
    () => async () => {
      setLoading(true);
      setListError(null);
      try {
        const found = await listSerialPorts();
        setPorts(found);
        // Keep the current selection if it still exists, else pick the first.
        setPath((current) => {
          if (current && found.some((port) => port.path === current)) return current;
          return found[0]?.path ?? "";
        });
      } catch (error) {
        const { message } = parseLumaError(error);
        setListError(message);
        setPorts([]);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // Reset transient framing state and (re)load ports each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setShowAdvanced(false);
    void refresh();
  }, [open, refresh]);

  const baudValid =
    Number.isInteger(baud) && baud >= SERIAL_BAUD_MIN && baud <= SERIAL_BAUD_MAX;
  const canConnect = Boolean(path) && baudValid;

  const connect = () => {
    if (!canConnect) return;
    const config: SerialConfig = {
      path,
      baudRate: baud,
      dataBits,
      parity,
      stopBits,
      flowControl,
    };
    // Errors after spawn (backend `serial` / `invalid-input`) surface in the
    // pane's disconnect banner with a Restart affordance, like other sessions.
    void openSerialSession(config);
    closeSerialConnect();
  };

  return (
    <Modal
      open={open}
      onOpenChange={(next) => !next && closeSerialConnect()}
      title="Serial terminal"
      description="Open a session on a local serial port."
      size="md"
      footer={
        <>
          <button
            type="button"
            onClick={() => closeSerialConnect()}
            className="rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={connect}
            disabled={!canConnect}
            className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground hover:brightness-110 disabled:opacity-50"
          >
            <Cable size={15} /> Connect
          </button>
        </>
      }
    >
      {/* Port selection */}
      <div className="flex items-end gap-2">
        <label className="min-w-0 flex-1 block">
          <span className="mb-1 block text-xs font-medium text-muted">Port</span>
          <div className="relative">
            <Usb size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
            <select
              value={path}
              onChange={(event) => setPath(event.target.value)}
              disabled={ports.length === 0}
              aria-label="Serial port"
              className="w-full appearance-none rounded-md border border-border bg-background py-2 pl-8 pr-8 text-sm outline-none focus:border-accent disabled:opacity-60"
            >
              {ports.length === 0 ? (
                <option value="">No serial ports detected</option>
              ) : (
                ports.map((port) => (
                  <option key={port.path} value={port.path}>
                    {port.path}
                    {port.kind !== "unknown" ? ` (${port.kind})` : ""}
                  </option>
                ))
              )}
            </select>
            <ChevronDown size={15} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-muted" />
          </div>
        </label>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          aria-label="Refresh serial ports"
          title="Refresh serial ports"
          className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-md border border-border text-muted hover:border-accent hover:text-accent disabled:opacity-50"
        >
          <RefreshCw size={15} className={cn(loading && "animate-spin")} />
        </button>
      </div>

      {listError && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {listError}
        </p>
      )}
      {!listError && !loading && ports.length === 0 && (
        <p className="mt-2 text-xs text-muted">
          No serial ports detected. Connect a device and choose Refresh.
        </p>
      )}

      {/* Baud rate */}
      <div className="mt-4">
        <span className="mb-1.5 block text-xs font-medium text-muted">Baud rate</span>
        <div className="flex flex-wrap gap-1.5">
          {SERIAL_BAUD_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => setBaud(preset)}
              className={cn(
                "rounded-md border px-2.5 py-1 text-xs transition",
                baud === preset
                  ? "border-accent bg-accent/15 text-accent"
                  : "border-border text-muted hover:border-accent hover:text-foreground",
              )}
            >
              {preset.toLocaleString()}
            </button>
          ))}
        </div>
        <label className="mt-2 block">
          <span className="mb-1 block text-[11px] font-medium text-muted">Custom rate</span>
          <input
            type="number"
            inputMode="numeric"
            min={SERIAL_BAUD_MIN}
            max={SERIAL_BAUD_MAX}
            value={Number.isFinite(baud) ? baud : ""}
            onChange={(event) => setBaud(event.target.valueAsNumber)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && canConnect) connect();
            }}
            aria-label="Custom baud rate"
            className={cn(
              "h-9 w-40 rounded-md border bg-background px-2.5 text-sm outline-none focus:border-accent",
              baudValid ? "border-border" : "border-danger",
            )}
          />
        </label>
        {!baudValid && (
          <p className="mt-1 text-xs text-danger">
            Baud rate must be between {SERIAL_BAUD_MIN.toLocaleString()} and{" "}
            {SERIAL_BAUD_MAX.toLocaleString()}.
          </p>
        )}
      </div>

      {/* Advanced framing */}
      <button
        type="button"
        onClick={() => setShowAdvanced((value) => !value)}
        className="mt-4 flex w-full items-center justify-between border-t border-border pt-3 text-xs font-medium text-muted hover:text-foreground"
      >
        Advanced settings
        {showAdvanced ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {showAdvanced && (
        <div className="mt-3 grid grid-cols-2 gap-3">
          <SelectField label="Data bits" value={dataBits} options={DATA_BITS} onChange={(v) => setDataBits(Number(v) as SerialDataBits)} />
          <SelectField label="Stop bits" value={stopBits} options={STOP_BITS} onChange={(v) => setStopBits(Number(v) as SerialStopBits)} />
          <SelectField label="Parity" value={parity} options={PARITIES} onChange={(v) => setParity(v as SerialParity)} capitalize />
          <SelectField label="Flow control" value={flowControl} options={FLOW_CONTROLS} onChange={(v) => setFlowControl(v as SerialFlowControl)} capitalize />
        </div>
      )}
    </Modal>
  );
}

function SelectField<T extends string | number>({
  label,
  value,
  options,
  onChange,
  capitalize = false,
}: {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (value: string) => void;
  capitalize?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          "w-full rounded-md border border-border bg-background px-2.5 py-2 text-sm outline-none focus:border-accent",
          capitalize && "capitalize",
        )}
      >
        {options.map((option) => (
          <option key={String(option)} value={option}>
            {String(option)}
          </option>
        ))}
      </select>
    </label>
  );
}
