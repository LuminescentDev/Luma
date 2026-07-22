import {
  KeyRound,
  type LucideIcon,
  Server,
  ShieldCheck,
  TerminalSquare,
} from 'lucide-react';

type Feature = {
  id?: string;
  icon: LucideIcon;
  title: string;
  summary: string;
  points: string[];
};

const features: Feature[] = [
  {
    icon: TerminalSquare,
    title: 'Terminals',
    summary:
      'Fast native terminals rendered with xterm.js, with everything you expect from a modern console.',
    points: [
      'Native PTY terminals via xterm.js',
      'Shell discovery and profiles',
      'Tabs with split panes',
      'Search, links, and WebGL rendering',
      'Serial terminals with port and baud',
      'Optional workspace persistence',
    ],
  },
  {
    icon: Server,
    title: 'SSH & host management',
    summary:
      'Organise every server and connect through embedded SSH or your system OpenSSH client.',
    points: [
      'Saved hosts, groups, tags, and search',
      'Embedded russh or system OpenSSH',
      'Encrypted reusable identities',
      'ProxyJump, agent forwarding, keepalive',
      'Explicit unknown-host confirmation',
      'Import from OpenSSH and Termius',
    ],
  },
  {
    icon: KeyRound,
    title: 'SFTP & productivity',
    summary:
      'Move files and run your workflows without leaving the app or reaching for another tool.',
    points: [
      'Dual-pane local and remote browser',
      'Drag-and-drop transfers',
      'Progress, cancel, and retry',
      'Recursive directory transfers',
      'Parameterized snippet runner',
      'Port forwarding and command palette',
    ],
  },
  {
    id: 'security',
    icon: ShieldCheck,
    title: 'Security, backup & updates',
    summary:
      'Secrets stay encrypted and local, with optional end-to-end encrypted sync you control.',
    points: [
      'Argon2id + XChaCha20-Poly1305 encryption',
      'OS keychain integration',
      'E2E sync: folder, WebDAV, or Gist',
      'Redacting application logs',
      'Narrowly scoped Tauri capabilities',
      'Signed in-app updates',
    ],
  },
];

export function Features() {
  return (
    <section
      id='features'
      aria-labelledby='features-heading'
      className='mx-auto w-full max-w-6xl px-4 py-20 sm:px-6 sm:py-28 lg:px-8'
    >
      <div className='max-w-2xl'>
        <p className='text-sm font-semibold uppercase tracking-widest text-accent'>
          Features
        </p>
        <h2
          id='features-heading'
          className='mt-3 text-3xl font-bold tracking-tight sm:text-4xl'
        >
          Everything you need in one client
        </h2>
        <p className='mt-4 text-base text-muted sm:text-lg'>
          Local shells, remote sessions, file transfers, and secrets management
          — designed to work together instead of across a handful of separate
          tools.
        </p>
      </div>

      <ul role='list' className='mt-12 divide-y divide-border/60 sm:mt-16'>
        {features.map((feature) => {
          const Icon = feature.icon;
          return (
            <li
              key={feature.title}
              id={feature.id}
              className='grid scroll-mt-24 gap-x-10 gap-y-5 py-10 first:pt-0 last:pb-0 md:grid-cols-12'
            >
              <div className='md:col-span-4'>
                <div className='flex items-center gap-3'>
                  <span className='inline-flex h-10 w-10 flex-none items-center justify-center rounded-xl text-accent filter-[drop-shadow(0_0_16px_rgba(240,204,251,0.45))]'>
                    <Icon className='h-6 w-6' aria-hidden='true' />
                  </span>
                  <h3 className='text-xl font-semibold tracking-tight'>
                    {feature.title}
                  </h3>
                </div>
              </div>
              <div className='md:col-span-8'>
                <p className='max-w-2xl text-base text-muted'>
                  {feature.summary}
                </p>
                <ul
                  role='list'
                  className='mt-4 flex flex-wrap items-center gap-x-2 gap-y-2 text-sm text-foreground/85'
                >
                  {feature.points.map((point, index) => (
                    <li key={point} className='flex items-center gap-2'>
                      {index > 0 && (
                        <span
                          aria-hidden='true'
                          className='h-1 w-1 flex-none rounded-full bg-accent/50'
                        />
                      )}
                      <span>{point}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
