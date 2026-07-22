import { ExternalLink, LifeBuoy, MessageSquareWarning, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import { GITHUB_ISSUES_URL, GITHUB_REPO_URL } from '../config';
import { Footer } from './Footer';

const troubleshooting = [
  {
    question: 'A host will not connect',
    answer:
      'Confirm the hostname, port, username, and network connection. If the server key changed, verify the new fingerprint with your administrator before accepting it.',
  },
  {
    question: 'Authentication is failing',
    answer:
      'Check that the selected password or private key belongs to the account you are using and that the server permits that authentication method.',
  },
  {
    question: 'Sync is not updating',
    answer:
      'Confirm that sync is enabled on each device and that each device can reach the configured provider. Avoid deleting local data until you have confirmed a recent backup.',
  },
];

export function Support() {
  return (
    <div className='min-h-screen bg-background'>
      <a
        href='#main'
        className='sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-100 focus:rounded-lg focus:bg-accent focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-accent-foreground'
      >
        Skip to content
      </a>

      <header className='border-b border-border/60 bg-background/70 backdrop-blur-md'>
        <div className='mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6 lg:px-8'>
          <Link to='/' className='flex items-center gap-2.5 rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent'>
            <img src='/logo.png' alt='' width={32} height={32} className='h-8 w-8 rounded-md' />
            <span className='text-lg font-semibold tracking-tight'>Luma</span>
          </Link>
          <Link to='/' className='text-sm text-muted transition-colors hover:text-foreground'>Back to Luma</Link>
        </div>
      </header>

      <main id='main' className='mx-auto w-full max-w-4xl px-4 py-16 sm:px-6 sm:py-24 lg:px-8'>
        <div className='mb-14 max-w-2xl'>
          <div className='mb-5 inline-flex h-12 w-12 items-center justify-center rounded-xl border border-accent/20 bg-accent/10 text-accent'>
            <LifeBuoy className='h-6 w-6' aria-hidden='true' />
          </div>
          <h1 className='text-4xl font-semibold tracking-tight sm:text-5xl'>Luma Support</h1>
          <p className='mt-5 text-lg leading-8 text-muted'>
            Find quick answers, report a problem, or request help with Luma.
          </p>
        </div>

        <section aria-labelledby='contact-heading' className='mb-14 grid gap-5 sm:grid-cols-2'>
          <div className='rounded-2xl border border-border bg-surface p-6'>
            <MessageSquareWarning className='mb-4 h-6 w-6 text-accent' aria-hidden='true' />
            <h2 id='contact-heading' className='text-xl font-semibold'>Contact support</h2>
            <p className='mt-3 leading-7 text-muted'>
              Open a support request on GitHub. Include your device, operating system version, Luma version, and the steps that caused the problem. Do not include passwords, private keys, or other secrets.
            </p>
            <a href={GITHUB_ISSUES_URL} target='_blank' rel='noreferrer noopener' className='mt-5 inline-flex items-center gap-2 font-medium text-accent hover:text-accent-strong'>
              Create a support request <ExternalLink className='h-4 w-4' aria-hidden='true' />
            </a>
          </div>

          <div className='rounded-2xl border border-border bg-surface p-6'>
            <ShieldCheck className='mb-4 h-6 w-6 text-accent' aria-hidden='true' />
            <h2 className='text-xl font-semibold'>Security issues</h2>
            <p className='mt-3 leading-7 text-muted'>
              Please do not post sensitive security reports publicly. Follow the private vulnerability reporting instructions in the Luma repository.
            </p>
            <a href={`${GITHUB_REPO_URL}security`} target='_blank' rel='noreferrer noopener' className='mt-5 inline-flex items-center gap-2 font-medium text-accent hover:text-accent-strong'>
              View security information <ExternalLink className='h-4 w-4' aria-hidden='true' />
            </a>
          </div>
        </section>

        <section aria-labelledby='troubleshooting-heading'>
          <h2 id='troubleshooting-heading' className='text-2xl font-semibold'>Troubleshooting</h2>
          <div className='mt-6 divide-y divide-border rounded-2xl border border-border bg-surface px-6'>
            {troubleshooting.map(({ question, answer }) => (
              <div key={question} className='py-6'>
                <h3 className='font-semibold'>{question}</h3>
                <p className='mt-2 leading-7 text-muted'>{answer}</p>
              </div>
            ))}
          </div>
        </section>

        <p className='mt-10 text-sm text-muted'>Luma is currently in early development. Support is provided on a best-effort basis.</p>
      </main>

      <Footer />
    </div>
  );
}
