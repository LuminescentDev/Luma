import {
  AlertTriangle,
  ArrowDownUp,
  Cable,
  Cloud,
  CloudAlert,
  FolderOpen,
  Menu,
  Minus,
  RefreshCw,
  Server,
  Square,
  X,
} from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useUiStore } from '../stores/uiStore';
import { selectRunningCount, useTunnelStore } from '../stores/tunnelStore';
import { selectActiveTransferCount, useSftpStore } from '../stores/sftpStore';
import { useSyncConfig } from '../hooks/useSync';
import { useSyncStore } from '../stores/syncStore';
import { TabBar } from '../features/terminal/TabBar';

const appWindow = getCurrentWindow();

export function TitleBar() {
  const navOpen = useUiStore((s) => s.navOpen);
  const toggleNav = useUiStore((s) => s.toggleNav);
  const openNav = useUiStore((s) => s.openNav);
  const selectSection = useUiStore((s) => s.selectSection);
  const mainView = useUiStore((s) => s.mainView);
  const sftpActive = mainView === 'sftp';
  const runningTunnels = useTunnelStore(selectRunningCount);
  const activeTransfers = useSftpStore(selectActiveTransferCount);
  const { data: syncConfig } = useSyncConfig();
  return (
    <header
      data-tauri-drag-region
      onDoubleClick={() => void appWindow.toggleMaximize()}
      className='flex h-10 shrink-0 select-none items-center gap-1 border-b border-border bg-surface px-1.5'
    >
      <button
        type='button'
        onClick={toggleNav}
        onDoubleClick={(event) => event.stopPropagation()}
        aria-expanded={navOpen}
        aria-label='Toggle navigation'
        title='Toggle navigation'
        className='flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-raised hover:text-foreground'
      >
        <Menu size={15} />
      </button>
      <button
        type='button'
        onClick={() => {
          openNav();
          selectSection('hosts');
        }}
        onDoubleClick={(event) => event.stopPropagation()}
        aria-pressed={navOpen && mainView === 'hosts'}
        aria-label='Open Vaults'
        className={
          navOpen && mainView === 'hosts'
            ? 'flex h-7 shrink-0 items-center gap-1.5 rounded-lg bg-raised px-2.5 text-xs font-medium text-foreground'
            : 'flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-muted transition-colors hover:bg-raised hover:text-foreground'
        }
      >
        <Server size={13} className='text-accent' /> Vaults
      </button>
      <button
        type='button'
        onClick={() => selectSection('sftp')}
        onDoubleClick={(event) => event.stopPropagation()}
        title='SFTP'
        aria-pressed={sftpActive}
        aria-expanded={navOpen}
        aria-label='Toggle SFTP section'
        className={
          sftpActive
            ? 'flex h-7 shrink-0 items-center gap-1.5 rounded-lg bg-raised px-2.5 text-xs font-medium text-foreground'
            : 'flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-muted transition-colors hover:bg-raised hover:text-foreground'
        }
      >
        <FolderOpen size={13} className='text-accent' /> SFTP
      </button>
      <div
        data-tauri-drag-region
        className='flex min-w-0 flex-1 items-center pl-1'
      >
        <TabBar />
      </div>
      {/* Polite announcements for background status so state changes reach
          assistive tech without stealing focus. */}
      <span className='sr-only' role='status' aria-live='polite'>
        {[
          runningTunnels > 0
            ? `${runningTunnels} active tunnel${runningTunnels === 1 ? '' : 's'}`
            : null,
          activeTransfers > 0
            ? `${activeTransfers} active transfer${activeTransfers === 1 ? '' : 's'}`
            : null,
        ]
          .filter(Boolean)
          .join(', ')}
      </span>
      {runningTunnels > 0 && (
        <div
          title={`${runningTunnels} active tunnel${runningTunnels === 1 ? '' : 's'}`}
          className='mr-1 flex shrink-0 items-center gap-1 rounded-full bg-green-500/15 px-2 py-0.5 text-[10px] text-green-400'
        >
          <Cable size={11} /> {runningTunnels} tunnel
          {runningTunnels === 1 ? '' : 's'}
        </div>
      )}
      {activeTransfers > 0 && (
        <button
          type='button'
          onClick={() => selectSection('sftp')}
          onDoubleClick={(event) => event.stopPropagation()}
          title={`${activeTransfers} active transfer${activeTransfers === 1 ? '' : 's'} — open SFTP`}
          aria-label={`${activeTransfers} active transfer${activeTransfers === 1 ? '' : 's'}, open SFTP`}
          className='mr-1 flex shrink-0 items-center gap-1 rounded-full bg-accent/15 px-2 py-0.5 text-[10px] text-accent hover:brightness-110'
        >
          <ArrowDownUp size={11} /> {activeTransfers}
        </button>
      )}
      {syncConfig?.enabled && <SyncIndicator />}
      <div className='flex h-full shrink-0 items-stretch'>
        <WindowButton
          label='Minimize'
          onClick={() => void appWindow.minimize()}
        >
          <Minus size={15} />
        </WindowButton>
        <WindowButton
          label='Maximize or restore'
          onClick={() => void appWindow.toggleMaximize()}
        >
          <Square size={12} />
        </WindowButton>
        <WindowButton
          label='Close'
          destructive
          onClick={() => void appWindow.close()}
        >
          <X size={15} />
        </WindowButton>
      </div>
    </header>
  );
}

function SyncIndicator() {
  const status = useSyncStore((s) => s.status);
  const conflictCount = useSyncStore((s) => s.conflicts.length);
  const activate = useSyncStore((s) => s.activate);

  const config: Record<
    string,
    { Icon: typeof Cloud; className: string; label: string; spin?: boolean }
  > = {
    idle: {
      Icon: Cloud,
      className: 'text-muted hover:text-foreground',
      label: 'Sync now',
    },
    syncing: {
      Icon: RefreshCw,
      className: 'text-accent',
      label: 'Syncing…',
      spin: true,
    },
    error: {
      Icon: CloudAlert,
      className: 'text-danger',
      label: 'Sync error — retry',
    },
    conflict: {
      Icon: AlertTriangle,
      className: 'text-amber-400',
      label: `${conflictCount} sync conflict${conflictCount === 1 ? '' : 's'} — resolve`,
    },
  };
  const { Icon, className, label, spin } = config[status] ?? config.idle;

  return (
    <>
      <span className='sr-only' role='status' aria-live='polite'>
        {status === 'idle' ? '' : `Sync: ${label}`}
      </span>
      <button
        type='button'
        title={label}
        aria-label={label}
        onClick={() => activate()}
        onDoubleClick={(event) => event.stopPropagation()}
        className={`mr-1 flex shrink-0 items-center rounded-md p-1.5 transition-colors hover:bg-raised ${className}`}
      >
        <Icon size={15} className={spin ? 'animate-spin' : undefined} />
      </button>
    </>
  );
}

function WindowButton({
  label,
  onClick,
  destructive = false,
  children,
}: {
  label: string;
  onClick: () => void;
  destructive?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type='button'
      aria-label={label}
      title={label}
      onClick={onClick}
      onDoubleClick={(event) => event.stopPropagation()}
      className={
        destructive
          ? 'flex w-10 items-center justify-center rounded-md text-muted transition-colors hover:bg-danger hover:text-white'
          : 'flex w-10 items-center justify-center rounded-md text-muted transition-colors hover:bg-raised hover:text-foreground'
      }
    >
      {children}
    </button>
  );
}
