import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, privacyContact } from "@/components/legal/LegalPage";

export const metadata: Metadata = {
  title: "Data deletion instructions | Open-autoDM",
  description:
    "How to request deletion of personal data from the private Open-autoDM service.",
};

export default function DataDeletionPage() {
  return (
    <LegalPage title="Data deletion instructions">
      <section>
        <h2>Contact the operator</h2>
        <p>
          To request deletion of personal data stored by Open-autoDM at
          autodm.niar42.com, contact Nikita Arkhipov through{" "}
          <a href={privacyContact}>Telegram @niarkh</a>. Contact information is
          also available at <a href="https://niar42.com/">niar42.com</a>.
        </p>
        <p>
          Say that your request concerns Open-autoDM. Include your Instagram or
          Facebook username, the account you interacted with, and the
          approximate date of the interaction. Account owners can also identify
          the connected Page or advertising account and specify whether they
          want it disconnected.
        </p>
      </section>
      <section>
        <h2>How requests are handled</h2>
        <p>
          Requests are handled by the operator. We verify that the request
          concerns your data or an account you are authorized to manage, locate
          the relevant records, and confirm the outcome or explain any
          applicable limitation. We may ask for the minimum additional
          information needed for verification.
        </p>
        <p>
          Depending on the verified request, relevant records can include
          stored interactions, contact records, account connections and their
          tokens, publication configuration, statistics and advertising records
          held by this service.
        </p>
      </section>
      <section>
        <h2>Stop platform access</h2>
        <p>
          You can revoke the app&apos;s access through Instagram or Facebook
          settings for connected apps and websites. Authorized owners can also
          disconnect accounts through the service. A separate deletion request
          is needed for records already stored by Open-autoDM.
        </p>
      </section>
      <section>
        <h2>Copies held elsewhere</h2>
        <p>
          Deletion from Open-autoDM does not automatically remove original
          Instagram or Facebook content, advertising objects on Meta, data
          already delivered to an external bot, or separately maintained
          backups. We will explain the applicable limits for your request.
          Requests concerning another provider&apos;s copies should also be
          addressed to that provider.
        </p>
        <p>
          Read the <Link href="/privacy">privacy policy</Link> for data types,
          purposes, service providers and retention information.
        </p>
      </section>
    </LegalPage>
  );
}
