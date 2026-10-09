import Link from "next/link";
import type { ReactNode } from "react";

export const privacyContact = "https://t.me/niarkh";
export const policyDate = "October 6, 2026";

export function LegalPage({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12 sm:py-16">
      <header className="mb-10 border-b border-border pb-8">
        <Link href="/" className="text-sm font-semibold text-primary">
          Open-autoDM · autodm.niar42.com
        </Link>
        <h1 className="mt-5 text-3xl font-bold tracking-tight sm:text-4xl">
          {title}
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Last updated: {policyDate}
        </p>
      </header>
      <div className="space-y-8 text-base leading-7 [&_h2]:mb-3 [&_h2]:text-xl [&_h2]:font-semibold [&_p+p]:mt-3 [&_ul]:mt-3 [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-6 [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-4">
        {children}
      </div>
      <footer className="mt-12 flex flex-wrap gap-5 border-t border-border pt-6 text-sm text-muted-foreground">
        <Link href="/privacy">Privacy policy</Link>
        <Link href="/data-deletion">Data deletion instructions</Link>
        <a href={privacyContact}>Contact the operator</a>
      </footer>
    </main>
  );
}
