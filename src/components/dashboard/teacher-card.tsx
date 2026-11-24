import { SignOutButton } from "@/components/auth/sign-out-button";
import { signOut } from "@/lib/auth/actions";
import { getCurrentProfile } from "@/lib/auth/dal";

/** Signed-in teacher + sign out. Reads the session, so render it inside <Suspense>. */
export async function TeacherCard() {
  const { fullName, email } = await getCurrentProfile();
  const displayName = fullName ?? email ?? "Teacher";

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-sidebar-border p-3">
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-linear-to-br from-brand-purple to-brand-blue text-sm font-semibold text-white uppercase"
        >
          {displayName.charAt(0)}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{displayName}</p>
          {email && fullName ? <p className="truncate text-xs text-muted-foreground">{email}</p> : null}
        </div>
      </div>
      <form action={signOut}>
        <SignOutButton />
      </form>
    </div>
  );
}

export function TeacherCardSkeleton() {
  return <div className="h-24 animate-pulse rounded-xl bg-muted" aria-hidden="true" />;
}

/** Inline display name for greetings; falls back to nothing. Render inside <Suspense>. */
export async function TeacherName({ prefix = "" }: { prefix?: string }) {
  const { fullName } = await getCurrentProfile();
  return fullName ? `${prefix}${fullName}` : null;
}
