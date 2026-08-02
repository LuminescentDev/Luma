/*
 * The plain-language disclosure shared by the desktop dialog, the mobile sheet
 * and both Settings screens, so there is exactly one place where what Luma
 * sends is described — and no way for the two shells to drift apart.
 */
export function AnalyticsDisclosure() {
  return (
    <div className="space-y-3 text-sm text-muted">
      <p>
        Luma can send a small, anonymous record of app launches and failures, so
        we know which versions and platforms are still in use and can find bugs
        that nobody reports.
      </p>
      <div>
        <p className="font-medium text-foreground">What is sent</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-5">
          <li>That the app was launched, and how long it stayed open</li>
          <li>The app version and your operating system</li>
          <li>Whether this is a development build</li>
          <li>
            When something fails, the kind of failure — "connection timed out",
            "transfer failed" — and how many times it has happened
          </li>
          <li>If the app crashes, the line of Luma's own source that crashed</li>
          <li>
            A random id for this install, so repeat launches and failures are
            recognisable as one install rather than many
          </li>
          <li>
            An approximate location — country, region and city — that our server
            looks up from your IP address when a report arrives. The address
            itself is not stored
          </li>
        </ul>
      </div>
      <div>
        <p className="font-medium text-foreground">What is never sent</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-5">
          <li>Hostnames, usernames, commands, output or file paths</li>
          <li>Keys, passwords or anything from a vault</li>
          <li>Your name, email or Luma account identity</li>
          <li>
            Error and crash messages themselves — only the category, never the
            text, which can quote a host or a path
          </li>
        </ul>
      </div>
      <p>
        The install id is random, is never sent to your other devices, and is
        deleted when you turn this off — so turning it off forgets this install
        rather than pausing it. Reports go to a server operated by Luma, not to
        a third-party analytics company.
      </p>
    </div>
  );
}
