"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef } from "react";
import { MailCheck, UserPlus } from "lucide-react";

import { FormAlert } from "@/components/auth/form-alert";
import { PasswordInput } from "@/components/auth/password-input";
import { ResendConfirmation } from "@/components/auth/resend-confirmation";
import { useFocusFirstError } from "@/components/auth/use-focus-first-error";
import { describedBy, Field } from "@/components/create/form-field";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { signUp } from "@/lib/auth/actions";
import type { SignUpState } from "@/lib/auth/schemas";

const initialState: SignUpState = { status: "idle" };
const FIELDS = [
  { field: "fullName", id: "signup-name" },
  { field: "email", id: "signup-email" },
  { field: "password", id: "signup-password" },
] as const;

export function SignupForm() {
  const [state, formAction, isPending] = useActionState(signUp, initialState);
  const alertRef = useRef<HTMLDivElement>(null);
  useFocusFirstError(state, FIELDS, alertRef);

  if (state.status === "success" && state.values?.email) {
    return <CheckEmail email={state.values.email} />;
  }

  const errors = state.fieldErrors ?? {};

  return (
    <form action={formAction} noValidate className="flex flex-col gap-5" aria-label="Create account">
      {state.message ? (
        <FormAlert tone="error" ref={alertRef}>
          {state.message}
        </FormAlert>
      ) : null}

      <Field id="signup-name" label="Your name" description="Shown on your dashboard." error={errors.fullName}>
        <Input
          id="signup-name"
          name="fullName"
          autoComplete="name"
          required
          maxLength={120}
          defaultValue={state.values?.fullName}
          aria-invalid={errors.fullName ? true : undefined}
          aria-describedby={describedBy("signup-name", { hasDescription: true, error: errors.fullName })}
          className="h-11 px-3"
        />
      </Field>

      <Field id="signup-email" label="Email address" error={errors.email}>
        <Input
          id="signup-email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          required
          defaultValue={state.values?.email}
          aria-invalid={errors.email ? true : undefined}
          aria-describedby={describedBy("signup-email", { error: errors.email })}
          className="h-11 px-3"
        />
      </Field>

      <Field id="signup-password" label="Password" description="At least 8 characters." error={errors.password}>
        <PasswordInput
          id="signup-password"
          name="password"
          autoComplete="new-password"
          required
          minLength={8}
          aria-invalid={errors.password ? true : undefined}
          aria-describedby={describedBy("signup-password", { hasDescription: true, error: errors.password })}
          className="h-11 px-3"
        />
      </Field>

      <Button type="submit" disabled={isPending} className="h-11 w-full text-base">
        <UserPlus data-icon="inline-start" />
        {isPending ? "Creating your account…" : "Create account"}
      </Button>
    </form>
  );
}

function CheckEmail({ email }: { email: string }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), []);

  return (
    <div className="flex flex-col gap-5 text-center">
      <span
        aria-hidden="true"
        className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-success text-success-foreground"
      >
        <MailCheck className="size-7" />
      </span>
      <div className="flex flex-col gap-2">
        <h2 ref={headingRef} tabIndex={-1} className="text-xl font-semibold outline-none">
          Check your inbox
        </h2>
        <p className="text-sm text-muted-foreground">
          We sent a confirmation link to <span className="font-semibold break-all text-foreground">{email}</span>.
          Open it to finish setting up your account, then you’re ready to create slides.
        </p>
        <p className="text-sm text-muted-foreground">Didn’t get it? Check your spam folder or send it again.</p>
      </div>
      <ResendConfirmation email={email} />
      <Link href="/login" className={buttonVariants({ variant: "link", className: "mx-auto" })}>
        Back to log in
      </Link>
    </div>
  );
}
