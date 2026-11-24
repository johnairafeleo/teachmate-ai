import type { ReactNode } from "react";

import { Logo } from "@/components/brand/logo";

/** Shared shell for /login and /signup: centred card over a soft brand backdrop. */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-full flex-1 flex-col overflow-hidden bg-linear-to-b from-accent/60 to-background">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-32 -left-24 size-96 rounded-full bg-brand-purple/10 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-24 -bottom-32 size-96 rounded-full bg-brand-blue/10 blur-3xl"
      />
      <header className="relative mx-auto flex h-16 w-full max-w-6xl items-center px-4 sm:px-6">
        <Logo />
      </header>
      <main
        id="main-content"
        tabIndex={-1}
        className="relative flex flex-1 items-start justify-center px-4 pt-6 pb-16 sm:items-center sm:pt-0"
      >
        {children}
      </main>
    </div>
  );
}
