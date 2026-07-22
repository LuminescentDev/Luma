import { ShieldCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import { SUPPORT_EMAIL } from '../config';
import { Footer } from './Footer';

export function Privacy() {
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
            <ShieldCheck className='h-6 w-6' aria-hidden='true' />
          </div>
          <h1 className='text-4xl font-semibold tracking-tight sm:text-5xl'>Privacy Policy</h1>
          <p className='mt-5 text-lg leading-8 text-muted'>
            Luma is designed to keep your data on your devices and does not require an account.
          </p>
          <p className='mt-3 text-sm text-muted'>Last updated: July 22, 2026</p>
        </div>

        <div className='space-y-10 leading-7 text-muted'>
          <PolicySection title='The Luma app'>
            <p>
              Luma does not include advertising, tracking, or product-usage telemetry. Your hosts, settings, snippets, credentials, keys, and session data are stored locally on your device by default. We do not operate Luma accounts or servers that receive this data.
            </p>
          </PolicySection>

          <PolicySection title='Optional sync and network features'>
            <p>
              If you enable sync, Luma sends an end-to-end encrypted copy of the data you choose to the provider you configure, such as WebDAV, GitHub Gist, or a local folder. That provider processes data under its own privacy policy. Luma also contacts remote hosts when you initiate a connection and may contact the update server when checking for app updates. These requests necessarily reveal technical information such as your IP address to the service you contact.
            </p>
          </PolicySection>

          <PolicySection title='Website analytics'>
            <p>
              This website uses a self-hosted Umami analytics service to understand aggregate traffic. It does not use advertising cookies or build cross-site profiles. The analytics service may process limited technical data such as the page visited, referrer, browser, device type, country derived from an IP address, and a truncated or hashed network identifier. We use this information only to maintain and improve the website.
            </p>
          </PolicySection>

          <PolicySection title='When you contact us'>
            <p>
              If you email support or submit a GitHub issue, we receive the information you choose to provide, along with the metadata handled by your email provider or GitHub. We use it only to respond, troubleshoot, maintain security, and improve Luma. Please do not send passwords, private keys, or other secrets.
            </p>
          </PolicySection>

          <PolicySection title='Data sharing and retention'>
            <p>
              We do not sell personal information. Information you send for support is shared only when needed to operate or protect the project, comply with law, or with service providers acting on our behalf. We keep it only as long as reasonably necessary for those purposes. You can request deletion of support correspondence, subject to legal and security requirements.
            </p>
          </PolicySection>

          <PolicySection title='Your choices and changes'>
            <p>
              You can avoid website analytics by using browser tracking protection or a content blocker, and you can use Luma without enabling sync. We may update this policy as Luma changes; the date above will show the latest revision.
            </p>
          </PolicySection>

          <PolicySection title='Contact'>
            <p>
              Questions or privacy requests can be sent to{' '}
              <a href={`mailto:${SUPPORT_EMAIL}`} className='font-medium text-accent hover:text-accent-strong'>
                {SUPPORT_EMAIL}
              </a>.
            </p>
          </PolicySection>
        </div>
      </main>

      <Footer />
    </div>
  );
}

function PolicySection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className='mb-3 text-xl font-semibold text-foreground'>{title}</h2>
      {children}
    </section>
  );
}
