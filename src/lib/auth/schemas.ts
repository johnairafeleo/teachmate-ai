import { z } from "zod";

/**
 * Zod schemas for auth forms. Server Actions validate every submission with these; the forms
 * only add HTML hints (type, autocomplete). Limits mirror Supabase Auth and the database:
 * - passwords: hosted project minimum is 8 characters; bcrypt reads at most 72 bytes.
 * - full name: public.profiles.full_name allows 1–120 characters without control characters.
 */

const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/;

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, "Enter your email address.")
  .max(254, "That email address is too long.")
  .pipe(z.email("Enter a valid email address, like name@school.edu.ph."));

const newPasswordSchema = z
  .string()
  .min(8, "Use at least 8 characters.")
  .refine((value) => new TextEncoder().encode(value).length <= 72, "Use 72 characters or fewer.");

const fullNameSchema = z
  .string()
  .transform((value) => value.replace(/\s+/g, " ").trim())
  .pipe(
    z
      .string()
      .min(1, "Enter your name.")
      .max(120, "Use 120 characters or fewer.")
      .refine((value) => !CONTROL_CHARS.test(value), "Remove special control characters."),
  );

export const signInSchema = z.object({
  email: emailSchema,
  // Never reveal the password policy on sign-in; only reject empty or absurd input.
  password: z.string().min(1, "Enter your password.").max(1024, "That password is too long."),
});

export const signUpSchema = z.object({
  fullName: fullNameSchema,
  email: emailSchema,
  password: newPasswordSchema,
});

export const resendSchema = z.object({ email: emailSchema });

export type SignInField = keyof z.input<typeof signInSchema>;
export type SignUpField = keyof z.input<typeof signUpSchema>;

/** Result of an auth Server Action, consumed by `useActionState` in the forms. */
export type AuthFormState<Field extends string> = {
  status: "idle" | "error" | "success";
  /** Form-level message (fixed copy, never raw provider text). */
  message?: string;
  fieldErrors?: Partial<Record<Field, string>>;
  /** Non-secret values echoed back so the form keeps them after a failed submit. */
  values?: { email?: string; fullName?: string };
  /** Lets the login form offer "resend confirmation email". */
  reason?: "email_not_confirmed";
};

export type SignInState = AuthFormState<SignInField>;
export type SignUpState = AuthFormState<SignUpField>;
export type ResendState = AuthFormState<"email">;

/** First message per field, in schema order. */
export function fieldErrorsFrom<Field extends string>(error: z.ZodError): Partial<Record<Field, string>> {
  const errors: Partial<Record<Field, string>> = {};
  for (const issue of error.issues) {
    const field = issue.path[0];
    if (typeof field === "string" && !(field in errors)) errors[field as Field] = issue.message;
  }
  return errors;
}

/** Read a text field from FormData; files and missing fields become "". */
export function formText(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}
