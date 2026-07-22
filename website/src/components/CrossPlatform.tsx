import { Monitor, Smartphone } from 'lucide-react';
import type { ComponentType, SVGProps } from 'react';
import { AppleIcon } from './AppleIcon';

type PlatformIcon = ComponentType<SVGProps<SVGSVGElement>>;
type Platform = { label: string; icon: PlatformIcon };

const platforms: Platform[] = [
  { label: 'Windows', icon: Monitor },
  { label: 'macOS', icon: AppleIcon },
  { label: 'Linux', icon: Monitor },
  { label: 'iOS', icon: AppleIcon },
  { label: 'Android', icon: Smartphone },
];

export function CrossPlatform() {
  return (
    <section
      aria-labelledby='platforms-heading'
      className='relative border-y border-border/60 bg-surface/70 backdrop-blur-sm'
    >
      <div
        aria-hidden='true'
        className='pointer-events-none absolute inset-x-0 top-0 h-px bg-linear-to-r from-transparent via-accent/25 to-transparent'
      />
      <div
        aria-hidden='true'
        className='pointer-events-none absolute inset-x-0 bottom-0 h-px bg-linear-to-r from-transparent via-accent/25 to-transparent'
      />
      <div className='mx-auto w-full max-w-6xl px-4 py-16 text-center sm:px-6 sm:py-20 lg:px-8'>
        <p className='text-sm font-semibold uppercase tracking-widest text-accent'>
          Cross-platform
        </p>
        <h2
          id='platforms-heading'
          className='mt-3 text-3xl font-bold tracking-tight sm:text-4xl'
        >
          One client, five platforms
        </h2>
        <p className='mx-auto mt-4 max-w-2xl text-base text-muted sm:text-lg'>
          Built with Tauri instead of Electron for a small, native footprint on
          desktop and mobile alike.
        </p>

        <ul
          role='list'
          className='mx-auto mt-12 flex max-w-3xl flex-wrap items-center justify-center gap-x-6 gap-y-4 sm:gap-x-10'
        >
          {platforms.map((platform, index) => {
            const Icon = platform.icon;
            return (
              <li
                key={platform.label}
                className='flex items-center gap-4 text-sm font-medium sm:gap-8'
              >
                {index > 0 && (
                  <span
                    aria-hidden='true'
                    className='hidden h-6 w-px bg-border/70 sm:block'
                  />
                )}
                <span className='flex items-center gap-2.5'>
                  <Icon
                    className='h-5 w-5 text-accent filter-[drop-shadow(0_0_12px_rgba(240,204,251,0.5))]'
                    aria-hidden='true'
                  />
                  {platform.label}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
