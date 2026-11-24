"use client";

import { useActionState, useRef } from "react";
import { LogIn } from "lucide-react";

import { FormAlert } from "@/components/auth/form-alert";
import { PasswordInput } from "@/components/auth/password-input";
import { ResendConfirmation } from "@/components/auth/resend-confirmation";
import { useFocusFirstError } from "@/components/auth/use-focus-first-error";
import { describedBy, Field } from "@/components/create/form-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { signIn } from "@/lib/auth/actions";
import type { SignInState } from "@/lib/auth/schemas";

const initialState: SignInState = { status: "idle" };
const FIELDS = [
  { field: "email", id: "login-email" },
  { field: "password", id: "login-password" },
] as const;

type LoginFormProps = {
  /** Sanitised post-login path (see safeNextPath). */
  next: string;
  notice?: string;
  error?: string;
};

export function LoginForm({ next, notice, error }: LoginFormProps) {
  const [state, formAction, isPending] = useActionState(signIn, initialState);
  const alertRef = useRef<HTMLDivElement>(null);
  useFocusFirstError(state, FIELDS, alertRef);

  const emailError = state.fieldErrors?.email;
  const passwordError = state.fieldErrors?.password;
  // Messages from the URL show until the first submit.
  const showUrlMessages = state.status === "idle";

  return (
    <div className="flex flex-col gap-5">
      <form action={formAction} noValidate className="flex flex-col gap-5" aria-label="Log in">
        <input type="hidden" name="next" value={next} />

        {showUrlMessages && notice ? <FormAlert tone="info">{notice}</FormAlert> : null}
        {showUrlMessages && error ? <FormAlert tone="error">{error}</FormAlert> : null}
        {state.message ? (
          <FormAlert tone="error" ref={alertRef}>
            {state.message}
          </FormAlert>
        ) : null}

        <Field id="login-email" label="Email address" error={emailError}>
          <Input
            id="login-email"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            required
            defaultValue={state.values?.email}
            aria-invalid={emailError ? true : undefined}
            aria-describedby={describedBy("login-email", { error: emailError })}
            className="h-11 px-3"
          />
        </Field>

        <Field id="login-password" label="Password" error={passwordError}>
          <PasswordInput
            id="login-password"
            name="password"
            autoComplete="current-password"
            required
            aria-invalid={passwordError ? true : undefined}
            aria-describedby={describedBy("login-password", { error: passwordError })}
            className="h-11 px-3"
          />
        </Field>

        <Button type="submit" disabled={isPending} className="h-11 w-full text-base">
          <LogIn data-icon="inline-start" />
          {isPending ? "Signing in…" : "Log in"}
        </Button>
      </form>

      {state.reason === "email_not_confirmed" && state.values?.email ? (
        <ResendConfirmation email={state.values.email} />
      ) : null}
    </div>
  );
}
