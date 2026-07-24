import { ChevronLeft, ChevronRight, Moon, Sun } from 'lucide-react';
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

type Theme = 'dark' | 'light';

type Slide = {
  view: string;
  label: string;
  alt: string;
};

const slides: Slide[] = [
  {
    view: 'terminal',
    label: 'Terminal',
    alt: 'Luma terminal view with a native shell session running in a tab, rendered with xterm.js.',
  },
  {
    view: 'hosts',
    label: 'Hosts',
    alt: 'Luma hosts view listing saved SSH connections organised into groups with tags and search.',
  },
  {
    view: 'snippets',
    label: 'Snippets',
    alt: 'Luma snippets view showing a library of reusable, parameterized commands.',
  },
  {
    view: 'settings',
    label: 'Settings',
    alt: 'Luma settings view with appearance, terminal, and encrypted sync configuration.',
  },
  {
    view: 'palette',
    label: 'Command palette',
    alt: 'Luma command palette open over the app with a searchable list of quick actions.',
  },
];

// Source screenshots are captured at a 1440x900 desktop viewport (8:5).
const IMG_WIDTH = 1440;
const IMG_HEIGHT = 900;
const AUTOPLAY_MS = 6000;

function shotSrc(theme: Theme, view: string, retina = false) {
  return `/screenshots/${theme}/${view}${retina ? '@2x' : ''}.png`;
}

export function Screenshots() {
  const [index, setIndex] = useState(0);
  const [theme, setTheme] = useState<Theme>('dark');
  const [paused, setPaused] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const regionRef = useRef<HTMLDivElement>(null);

  const count = slides.length;
  const active = slides[index];

  const go = useCallback(
    (next: number) => setIndex((next + count) % count),
    [count],
  );

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    if (paused || reducedMotion) return;
    const id = window.setInterval(
      () => setIndex((prev) => (prev + 1) % count),
      AUTOPLAY_MS,
    );
    return () => window.clearInterval(id);
  }, [paused, reducedMotion, count]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      go(index - 1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      go(index + 1);
    }
  };

  return (
    <section
      id='screenshots'
      aria-labelledby='screenshots-heading'
      className='mx-auto w-full max-w-6xl px-4 py-20 sm:px-6 sm:py-28 lg:px-8'
    >
      <div className='flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between'>
        <div className='max-w-2xl'>
          <p className='text-sm font-semibold uppercase tracking-widest text-accent'>
            A look inside
          </p>
          <h2
            id='screenshots-heading'
            className='mt-3 text-3xl font-bold tracking-tight sm:text-4xl'
          >
            See Luma in action
          </h2>
          <p className='mt-4 text-base text-muted sm:text-lg'>
            From local terminals to saved hosts, snippets, and the command
            palette — the same clean interface across every screen.
          </p>
        </div>

        <div
          role='group'
          aria-label='Preview theme'
          className='inline-flex flex-none items-center gap-1 self-start rounded-lg border border-border bg-surface p-1 sm:self-auto'
        >
          {(['dark', 'light'] as const).map((option) => {
            const selected = theme === option;
            const Icon = option === 'dark' ? Moon : Sun;
            return (
              <button
                key={option}
                type='button'
                onClick={() => setTheme(option)}
                aria-pressed={selected}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium capitalize transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                  selected
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted hover:text-foreground'
                }`}
              >
                <Icon className='h-4 w-4' aria-hidden='true' />
                {option}
              </button>
            );
          })}
        </div>
      </div>

      <div
        ref={regionRef}
        role='group'
        aria-roledescription='carousel'
        aria-label='Luma screenshots'
        tabIndex={0}
        onKeyDown={onKeyDown}
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        onFocus={() => setPaused(true)}
        onBlur={() => setPaused(false)}
        className='group relative mt-10 rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent sm:mt-14'
      >
        <div
          aria-hidden='true'
          className='pointer-events-none absolute -inset-4 -z-10 rounded-3xl bg-[radial-gradient(circle_at_50%_0%,rgba(240,204,251,0.14),transparent_65%)]'
        />

        <div className='overflow-hidden rounded-xl border border-border bg-surface shadow-glow'>
          <div
            className='flex'
            style={{
              transform: `translateX(-${index * 100}%)`,
              transition: reducedMotion
                ? 'none'
                : 'transform 500ms cubic-bezier(0.22, 1, 0.36, 1)',
            }}
          >
            {slides.map((slide, slideIndex) => {
              const isActive = slideIndex === index;
              return (
                <div
                  key={slide.view}
                  role='group'
                  aria-roledescription='slide'
                  aria-label={`${slideIndex + 1} of ${count}: ${slide.label}`}
                  aria-hidden={!isActive}
                  inert={!isActive}
                  className='min-w-full'
                  style={{ aspectRatio: `${IMG_WIDTH} / ${IMG_HEIGHT}` }}
                >
                  <img
                    src={shotSrc(theme, slide.view)}
                    srcSet={`${shotSrc(theme, slide.view)} 1x, ${shotSrc(theme, slide.view, true)} 2x`}
                    width={IMG_WIDTH}
                    height={IMG_HEIGHT}
                    alt={slide.alt}
                    loading={isActive ? 'eager' : 'lazy'}
                    draggable={false}
                    className='h-full w-full object-cover'
                  />
                </div>
              );
            })}
          </div>
        </div>

        <button
          type='button'
          onClick={() => go(index - 1)}
          aria-label='Previous screenshot'
          className='absolute left-3 top-1/2 inline-flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-background/80 text-foreground backdrop-blur-sm transition-colors hover:border-accent/60 hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
        >
          <ChevronLeft className='h-5 w-5' aria-hidden='true' />
        </button>
        <button
          type='button'
          onClick={() => go(index + 1)}
          aria-label='Next screenshot'
          className='absolute right-3 top-1/2 inline-flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-background/80 text-foreground backdrop-blur-sm transition-colors hover:border-accent/60 hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
        >
          <ChevronRight className='h-5 w-5' aria-hidden='true' />
        </button>
      </div>

      <div className='mt-6 flex flex-col items-center gap-4 sm:flex-row sm:justify-between'>
        <p aria-live='polite' className='text-sm font-medium text-foreground'>
          <span className='text-accent'>{active.label}</span>
          <span className='text-muted'>
            {' '}
            — {index + 1} of {count}
          </span>
        </p>

        <div
          role='group'
          aria-label='Choose a screenshot'
          className='flex items-center gap-2.5'
        >
          {slides.map((slide, slideIndex) => {
            const selected = slideIndex === index;
            return (
              <button
                key={slide.view}
                type='button'
                aria-label={`Show ${slide.label} screenshot`}
                aria-current={selected ? 'true' : undefined}
                onClick={() => setIndex(slideIndex)}
                className={`h-2.5 rounded-full transition-all focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                  selected
                    ? 'w-6 bg-accent'
                    : 'w-2.5 bg-border hover:bg-accent/50'
                }`}
              />
            );
          })}
        </div>
      </div>
    </section>
  );
}
