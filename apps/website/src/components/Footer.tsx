import { Link } from 'react-router-dom';
import { GITHUB_REPO_URL } from '../config';
import { GithubIcon } from './GithubIcon';

export function Footer() {
  return (
    <footer className='relative border-t border-border/60 bg-background/60 backdrop-blur-sm'>
      <div
        aria-hidden='true'
        className='pointer-events-none absolute inset-x-0 top-0 h-px bg-linear-to-r from-transparent via-accent/20 to-transparent'
      />
      <div className='mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-12 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8'>
        <div className='flex items-center gap-2.5'>
          <img
            src='/logo.png'
            alt=''
            width={28}
            height={28}
            className='h-7 w-7 rounded-md'
          />
          <div>
            <p className='text-sm font-semibold'>Luma</p>
            <p className='text-xs text-muted'>
              Terminal &amp; SSH client, built with Tauri.
            </p>
          </div>
        </div>

        <div className='flex flex-col gap-3 text-sm text-muted sm:items-end'>
          <div className='flex items-center gap-5'>
            <Link
              to='/support'
              className='rounded-sm transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent'
            >
              Support
            </Link>
            <Link
              to='/privacy'
              className='rounded-sm transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent'
            >
              Privacy
            </Link>
            <a
              href={GITHUB_REPO_URL}
              target='_blank'
              rel='noreferrer noopener'
              className='inline-flex items-center gap-2 rounded-sm transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent'
            >
              <GithubIcon className='h-4 w-4' />
              GitHub
            </a>
          </div>
          <p>
            Licensed under{' '}
            <span className='font-medium text-foreground'>MIT</span>. In early
            development — expect rough edges and breaking changes.
          </p>
        </div>
      </div>
    </footer>
  );
}
