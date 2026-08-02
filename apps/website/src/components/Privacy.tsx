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
            Luma keeps your data on your devices by default. An account is required only for optional Luma Cloud services.
          </p>
          <p className='mt-3 text-sm text-muted'>Last updated: August 2, 2026</p>
        </div>

        <div className='space-y-10 leading-7 text-muted'>
          <PolicySection title='The Luma app'>
            <p>
              Luma does not include advertising, cross-site tracking, or third-party analytics services. Your hosts, settings, snippets, credentials, keys, and session data are stored locally on your device by default. You can use the app without creating a Luma account or sending this data to us. The app includes optional anonymous product analytics, described below, which you can decline.
            </p>
          </PolicySection>

          <PolicySection title='Product analytics'>
            <p>
              Luma asks you once, on first launch, whether to share anonymous product analytics, and you can change the answer at any time in Settings → Privacy. Nothing is collected before you answer, and nothing is collected if you decline.
            </p>
            <p className='mt-3'>
              If you agree, the app reports that it was launched and, when it closes, how long it was open. Each report carries the app version, your operating system, and whether the build is a development build. It contains no hostnames, usernames, commands, command output, file paths, credentials, keys, or account identifiers.
            </p>
            <p className='mt-3'>
              The app also reports when an operation fails. A failure report carries a fixed category describing the kind of failure — for example that a connection timed out, that a transfer failed, or that a stored key was unavailable — together with a count of how often that category has occurred. The error message itself is never sent, because it can quote a hostname, a username, or a file path. If the app crashes, it additionally reports the file and line of Luma's own source code where the crash occurred, and never the crash message, which can contain arbitrary values from the running program.
            </p>
            <p className='mt-3'>
              Reports also carry a randomly generated identifier for that installation of Luma, so that repeated launches can be recognised as one installation rather than many. It is created only when you agree, is generated independently of your Luma account and of any identifier used for sync, is never copied to your other devices, and is deleted when you turn analytics off — so turning the setting off ends the association rather than pausing it, and turning it back on begins a new one.
            </p>
            <p className='mt-3'>
              These reports go to an analytics service that we operate ourselves, not to a third-party analytics company. As with any network request, that service receives your IP address, which it uses only to derive a coarse identifier and does not retain alongside your reports. If you would like the analytics records associated with your installation deleted, contact us at the address below with the identifier shown in Settings → Privacy.
            </p>
          </PolicySection>

          <PolicySection title='Optional sync'>
            <p>
              If you enable sync, Luma creates an end-to-end encrypted copy of the data selected for sync. Depending on your settings, that may include hosts, usernames, snippets, terminal profiles, port forwards, settings, credentials, and private keys. Your sync passphrase stays on your devices and is not sent with the encrypted copy.
            </p>
            <p className='mt-3'>
              With Luma Cloud, we store the current encrypted sync copy and up to 20 prior encrypted revisions. We also store an account identifier, a random storage identifier, storage usage and quota, and account creation, update, and deletion timestamps. We cannot read the contents of the encrypted copies without your sync passphrase.
            </p>
            <p className='mt-3'>
              If you instead configure a local folder, WebDAV, or GitHub Gist, the selected provider stores the encrypted copy and processes related account and request information under its own privacy policy.
            </p>
          </PolicySection>

          <PolicySection title='Accounts and collaboration'>
            <p>
              When you create or use a Luma Cloud account, our identity service processes the account and authentication information needed to sign you in. Luma stores authentication tokens in your device's protected credential storage. Signing out removes the local cloud session but does not delete the cloud account or its stored data.
            </p>
            <p className='mt-3'>
              If you use collaborative terminal features, the service stores account identifiers, device identifiers and public encryption keys, room identifiers, room membership and roles, encrypted room-key envelopes, and related creation, revocation, and deletion timestamps. It also stores encrypted room snapshots and temporarily processes encrypted terminal events, presence, and control state to operate the live session. Other room members receive the encrypted session information their role permits them to access.
            </p>
          </PolicySection>

          <PolicySection title='Service operation and logs'>
            <p>
              When you use Luma Cloud, collaboration, the website, app updates, or connect to a remote host, the service you contact necessarily receives network and request information such as your IP address, request time, route, response status, and user agent or device information. We and our infrastructure providers process operational logs to deliver, secure, troubleshoot, and prevent abuse of the services. Luma's cloud infrastructure uses service providers, including Cloudflare, for application, database, object-storage, and network services.
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
              We do not sell personal information. We disclose information only to provide a feature you request, to service providers acting on our behalf, to protect Luma and its users, or when required by law. Cloud data remains until you delete it or request account deletion, except for short-lived operational data, backups, records we must retain for legal or security reasons, and data retained by another provider you selected. Operational logs and support correspondence are kept only as long as reasonably necessary for their purposes.
            </p>
          </PolicySection>

          <PolicySection title='Your choices and deletion'>
            <p>
              You can use Luma without an account, cloud sync, or collaboration. You can decline product analytics at the first-run prompt, or turn them off at any time in Settings → Privacy. You can disable sync or sign out at any time. To delete a Luma Cloud account and its encrypted sync copies, or to request deletion of support correspondence, contact us at the address below. Deleting a cloud account does not delete copies already downloaded to your devices, shared with collaborators, or stored with a third-party sync provider. You can avoid website analytics by using browser tracking protection or a content blocker.
            </p>
          </PolicySection>

          <PolicySection title='Changes to this policy'>
            <p>
              We may update this policy as Luma changes. The date above shows the latest revision.
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
