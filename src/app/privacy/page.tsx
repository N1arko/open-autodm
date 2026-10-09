import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, privacyContact } from "@/components/legal/LegalPage";

export const metadata: Metadata = {
  title: "Privacy policy | Open-autoDM",
  description:
    "How the private Open-autoDM instance at autodm.niar42.com processes Instagram and Facebook data.",
};

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy policy">
      <section>
        <h2>Operator and scope</h2>
        <p>
          This policy covers the Open-autoDM instance at autodm.niar42.com,
          operated by Nikita Arkhipov. It supports Instagram and Facebook
          accounts that the operator owns or is authorized to manage. Access to
          its management interface and API is restricted to authorized owners
          and integrations.
        </p>
        <p>
          For privacy questions and requests, contact the operator through{" "}
          <a href={privacyContact}>Telegram @niarkh</a>. Contact information is
          also available at <a href="https://niar42.com/">niar42.com</a>.
        </p>
      </section>
      <section>
        <h2>Data we process</h2>
        <p>
          Data depends on the permissions granted to the Meta app and the
          features enabled for each connected account. It may include:
        </p>
        <ul>
          <li>
            Account and Page identifiers, usernames, profile information, granted
            permissions and access tokens; an authorized owner&apos;s login
            email and authentication information.
          </li>
          <li>
            Direct-message and comment content, platform-scoped sender
            identifiers, interaction timestamps, delivery information and
            contact records received through authorized Meta APIs and webhooks.
          </li>
          <li>
            Publication captions, media identifiers, media URLs, schedules,
            publication results, account and media statistics, and audience
            breakdowns provided by Meta.
          </li>
          <li>
            Advertising account information, campaigns, targeting and budget
            settings, creative references, reporting metrics and records of
            management operations.
          </li>
          <li>
            Request metadata and technical logs used to operate, secure and
            troubleshoot the service.
          </li>
        </ul>
      </section>
      <section>
        <h2>How data is used</h2>
        <p>
          We use this data to connect authorized accounts, receive and respond
          to interactions, route conversations to configured bots, schedule
          publications, retrieve statistics and carry out advertising
          instructions. We also use it to prevent duplicate operations, record
          delivery outcomes, verify access and investigate errors. Features
          require the relevant account permissions and owner configuration.
        </p>
        <p>We do not sell personal data.</p>
      </section>
      <section>
        <h2>Storage and service providers</h2>
        <p>
          The application and background workers run on the operator&apos;s
          server. Database and owner authentication services are provided by
          Supabase. Meta processes the API requests required for account
          connections, interactions, publications, statistics and advertising.
          Providers may process data in different countries according to their
          infrastructure and service terms.
        </p>
        <p>
          If an owner connects an external bot, the service sends the relevant
          message text, account and conversation identifiers, and delivery
          events to that bot&apos;s configured HTTPS endpoint. That bot may use
          an AI provider under its own configuration and policies. Data sent to
          an external bot is subject to that bot&apos;s retention and deletion
          practices. AI processing is determined by the connected bot.
        </p>
        <p>
          Media URLs supplied for publications or advertising may be sent to
          Meta so that Meta can retrieve and process the media.
        </p>
      </section>
      <section>
        <h2>Retention</h2>
        <p>
          The transport service schedules cleanup of completed incoming webhook
          records after seven days, and eligible message and completed-job
          records after thirty days. Records needed by pending jobs or linked
          replies can remain longer. Saved Instagram statistics use a retention
          setting for each account, with a default of ninety days.
        </p>
        <p>
          Account connections, contact records, configuration, publication
          records and advertising-operation history remain while needed to
          operate or audit the authorized account, or until deleted following a
          verified request. External platforms, bots and any separately
          maintained backups have their own retention settings; deletion from
          this service does not automatically delete those copies.
        </p>
      </section>
      <section>
        <h2>Access and protection</h2>
        <p>
          The service uses HTTPS, verified owner authentication, account
          ownership checks and restricted integration credentials. Stored Meta
          access tokens and integration secrets are encrypted. These controls
          limit access to the data required for an authorized operation.
        </p>
        <p>
          Owner login uses session cookies and browser storage. These public
          policy pages are available without signing in.
        </p>
      </section>
      <section>
        <h2>Your choices and requests</h2>
        <p>
          Authorized account owners can disconnect an account and revoke the
          app&apos;s access in Meta&apos;s account settings. Revoking access
          does not automatically delete previously stored records. You can
          request access, correction or deletion of personal data by contacting
          the operator. We may ask for information needed to verify the request
          and locate the relevant records.
        </p>
        <p>
          See our <Link href="/data-deletion">data deletion instructions</Link>
          {" "}for the request process. Removing records from this service does
          not remove posts, messages or advertising objects held by Instagram,
          Facebook or another provider.
        </p>
      </section>
      <section>
        <h2>Policy updates</h2>
        <p>
          We update this page when the service&apos;s data processing changes.
          The date above identifies the current version. Contact the operator
          with questions about an update.
        </p>
      </section>
    </LegalPage>
  );
}
