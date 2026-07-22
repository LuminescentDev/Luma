import { GITHUB_REPO_URL } from '../config';
import { GithubIcon } from './GithubIcon';

const navLinks = [
  { label: 'Features', href: '#features' },
  { label: 'Security', href: '#security' },
  { label: 'Download', href: '#download' },
];

export function Header() {
  return (
    <header className='sticky top-0 z-50 border-b border-border/60 bg-background/70 backdrop-blur-md'>
      <div
        aria-hidden='true'
        className='pointer-events-none absolute inset-x-0 bottom-0 h-px bg-linear-to-r from-transparent via-accent/25 to-transparent'
      />
      <div className='mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8'>
        <a
          href='#top'
          className='flex items-center gap-2.5 rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent'
          aria-label='Luma home'
        >
          <img
            src='/logo.png'
            alt=''
            width={32}
            height={32}
            className='h-8 w-8 rounded-md'
          />
          <span className='text-lg font-semibold tracking-tight'>Luma</span>
        </a>

        <nav aria-label='Primary' className='hidden md:block'>
          <ul className='flex items-center gap-8 text-sm text-muted'>
            {navLinks.map((link) => (
              <li key={link.href}>
                <a
                  href={link.href}
                  className='rounded-sm transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent'
                >
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <a
          href={GITHUB_REPO_URL}
          target='_blank'
          rel='noreferrer noopener'
          data-umami-event='github-header'
          className='inline-flex items-center gap-2 rounded-lg border border-border bg-raised px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:border-accent/60 hover:bg-raised/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
        >
          <GithubIcon className='h-4 w-4' />
          <span className='hidden sm:inline'>GitHub</span>
          <span className='sr-only sm:hidden'>Open Luma on GitHub</span>
        </a>
      </div>
    </header>
  );
}
