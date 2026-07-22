import { ArrowRight } from 'lucide-react';
import { GITHUB_REPO_URL } from '../config';
import { GithubIcon } from './GithubIcon';
import { NightSky } from './NightSky';

export function Hero() {
  return (
    <section
      id='top'
      className='relative overflow-hidden border-b border-border/60'
    >
      <NightSky />
      <div
        aria-hidden='true'
        className='pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(circle_at_50%_-20%,rgba(240,204,251,0.1),transparent_55%)]'
      />

      <div className='mx-auto flex w-full max-w-6xl flex-col items-center px-4 py-24 text-center sm:px-6 sm:py-32 lg:px-8'>
        <h1 className='mt-8 max-w-4xl text-balance text-4xl font-bold leading-[1.05] tracking-tight sm:text-6xl lg:text-7xl'>
          A lightweight
          <br />
          cross-platform
          <br />
          <span className='bg-[linear-gradient(180deg,#ffffff,#f0ccfb)] bg-clip-text text-transparent [text-shadow:0_0_40px_rgba(240,204,251,0.35)]'>
            terminal &amp; SSH client
          </span>
        </h1>

        <p className='mt-6 max-w-2xl text-pretty text-base text-muted sm:text-lg'>
          Luma combines local and serial terminals, saved SSH connections, SFTP,
          and end-to-end encrypted config sync in one modern app. No account and
          no paid cloud service required.
        </p>

        <div className='mt-10 flex flex-col items-center gap-4 sm:flex-row'>
          <a
            href={GITHUB_REPO_URL}
            target='_blank'
            rel='noreferrer noopener'
            data-umami-event='github-hero'
            className='group inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-3 text-sm font-semibold text-accent-foreground shadow-glow transition-colors hover:bg-accent-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
          >
            <GithubIcon className='h-4.5 w-4.5' />
            View on GitHub
            <ArrowRight
              className='h-4 w-4 transition-transform group-hover:translate-x-0.5'
              aria-hidden='true'
            />
          </a>
          <a
            href='#features'
            className='inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-5 py-3 text-sm font-semibold text-foreground transition-colors hover:border-accent/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
          >
            Explore features
          </a>
        </div>

        <p className='mt-6 text-xs text-muted'>
          Windows &middot; macOS &middot; Linux &middot; iOS &middot; Android
        </p>
      </div>
    </section>
  );
}
