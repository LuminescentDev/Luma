import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown, ShieldAlert, Vault as VaultIcon } from 'lucide-react';
import { useUiStore } from '../stores/uiStore';
import { useVaultStore } from '../stores/vaultStore';
import { useVaults } from '../hooks/useVaults';
import { cn } from '../lib/utils';

/**
 * Title-bar vault picker. Choosing a vault scopes the hosts view to it; "All
 * vaults" returns to the root where every vault is listed side by side. With
 * only one vault there is nothing to pick, so it is a plain button to Hosts.
 */
export function VaultSwitcher() {
  const navOpen = useUiStore((s) => s.navOpen);
  const openNav = useUiStore((s) => s.openNav);
  const selectSection = useUiStore((s) => s.selectSection);
  const mainView = useUiStore((s) => s.mainView);
  const { data: vaults } = useVaults();
  const activeVaultId = useVaultStore((s) => s.activeVaultId);
  const setActiveVault = useVaultStore((s) => s.setActiveVault);

  const list = vaults ?? [];
  const active = list.find((vault) => vault.id === activeVaultId) ?? null;
  const showing = navOpen && mainView === 'hosts';
  const className = showing
    ? 'flex h-7 shrink-0 items-center gap-1.5 rounded-lg bg-raised px-2.5 text-xs font-medium text-foreground'
    : 'flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-muted transition-colors hover:bg-raised hover:text-foreground';

  const openHosts = () => {
    openNav();
    selectSection('hosts');
  };

  if (list.length < 2) {
    return (
      <button
        type='button'
        onClick={openHosts}
        onDoubleClick={(event) => event.stopPropagation()}
        aria-pressed={showing}
        aria-label='Open Vaults'
        className={className}
      >
        <VaultIcon size={13} className='text-accent' /> Vaults
      </button>
    );
  }

  const select = (vaultId: string | null) => {
    setActiveVault(vaultId);
    openHosts();
  };

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type='button'
          onDoubleClick={(event) => event.stopPropagation()}
          aria-pressed={showing}
          aria-label='Switch vault'
          className={className}
        >
          <VaultIcon size={13} className='text-accent' />
          {active?.name ?? 'All vaults'}
          <ChevronDown size={12} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align='start'
          sideOffset={4}
          className='z-50 min-w-52 rounded-lg border border-border bg-raised p-1 text-sm shadow-glow'
        >
          <Item selected={active === null} onSelect={() => select(null)}>
            All vaults
          </Item>
          <DropdownMenu.Separator className='my-1 h-px bg-border' />
          {list.map((vault) => (
            <Item
              key={vault.id}
              selected={active?.id === vault.id}
              onSelect={() => select(vault.id)}
            >
              {vault.name}
              {vault.kind === 'shared' && vault.shareSecrets && (
                <ShieldAlert
                  size={12}
                  className='ml-auto shrink-0 text-amber-400'
                  aria-label='Shares private keys and passwords with every member'
                />
              )}
            </Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function Item({
  selected,
  onSelect,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <DropdownMenu.Item
      onSelect={onSelect}
      className={cn(
        'flex cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 outline-none data-highlighted:bg-surface data-highlighted:text-accent',
        selected && 'text-accent',
      )}
    >
      <Check size={13} className={selected ? undefined : 'invisible'} />
      {children}
    </DropdownMenu.Item>
  );
}
