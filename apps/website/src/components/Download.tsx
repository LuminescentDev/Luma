import { ArrowRight } from 'lucide-react';
import { GITHUB_REPO_URL } from '../config';
import { GithubIcon } from './GithubIcon';

export function Download() {
  return (
    <section
      id='download'
      aria-labelledby='download-heading'
      className='mx-auto w-full max-w-6xl px-4 pb-24 sm:px-6 lg:px-8'
    >
      <div className='relative overflow-hidden rounded-3xl border border-accent/25 bg-linear-to-b from-raised to-surface px-6 py-14 text-center shadow-[0_0_60px_-20px_rgba(240,204,251,0.35)] sm:px-12 sm:py-20'>
        <div
          aria-hidden='true'
          className='pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(circle_at_50%_0%,rgba(240,204,251,0.16),transparent_65%)]'
        />
        <div
          aria-hidden='true'
          className='pointer-events-none absolute inset-x-0 top-0 -z-10 h-px bg-linear-to-r from-transparent via-accent/60 to-transparent'
        />
        <h2
          id='download-heading'
          className='text-3xl font-bold tracking-tight sm:text-4xl'
        >
          Get Luma
        </h2>
        <p className='mx-auto mt-4 max-w-xl text-base text-muted sm:text-lg'>
          Luma is in early development. Grab a build from GitHub releases, or
          clone the repository and build it yourself.
        </p>
        <div className='mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row'>
          <a
            href={GITHUB_REPO_URL + 'releases'}
            target='_blank'
            rel='noreferrer noopener'
            data-umami-event='download-github-releases'
            className='group inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-3 text-sm font-semibold text-accent-foreground shadow-glow transition-colors hover:bg-accent-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
          >
            Download from GitHub Releases
            <ArrowRight
              className='h-4 w-4 transition-transform group-hover:translate-x-0.5'
              aria-hidden='true'
            />
          </a>
          <a
            href={GITHUB_REPO_URL}
            target='_blank'
            rel='noreferrer noopener'
            data-umami-event='github-view-source'
            className='inline-flex items-center gap-2 rounded-lg border border-border bg-raised px-5 py-3 text-sm font-semibold text-foreground transition-colors hover:border-accent/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
          >
            <GithubIcon className='h-4.5 w-4.5' />
            View source
          </a>
        </div>
      </div>
    </section>
  );
}
