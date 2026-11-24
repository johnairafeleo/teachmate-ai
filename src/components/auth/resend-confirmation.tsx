"use client";

import { useActionState } from "react";
import { MailPlus } from "lucide-react";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { resendConfirmation } from "@/lib/auth/actions";
import type { ResendState } from "@/lib/auth/schemas";

const initialState: ResendState = { status: "idle" };

/** Separate <form> (forms can't nest) that re-sends the sign-up confirmation email. */
export function ResendConfirmation({ email }: { email: string }) {
  const [state, formAction, isPending] = useActionState(resendConfirmation, initialState);
  const message = state.message ?? state.fieldErrors?.email;

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="email" value={email} />
      <Button type="submit" variant="outline" disabled={isPending} className="h-10 w-full">
        <MailPlus data-icon="inline-start" />
        {isPending ? "Sending…" : "Resend confirmation email"}
      </Button>
      {message ? <FormAlert tone={state.status === "success" ? "success" : "error"}>{message}</FormAlert> : null}
    </form>
  );
}
