import "server-only";

import { z } from "zod";

import { describeEnvIssues, getPublicEnv, isPrivilegedSupabaseKey } from "@/lib/env/public";

/**
 * Server-only environment variables. Importing this module from a Client Component is a build
 * error (`server-only`). Values are validated on first use.
 */

const serverEnvSchema = z.object({
  SUPABASE_SECRET_KEY: z
    .string()
    .trim()
    .min(20, "is missing or too short")
    .refine((key) => !key.startsWith("sb_publishable_"), {
      message: "is a publishable key — use the project's secret key",
    }),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | undefined;

/** Fail closed if any browser-exposed variable holds a privileged key. Reports names only. */
function assertNoSecretsInPublicVariables() {
  const leaked = Object.entries(process.env)
    .filter(([name, value]) => name.startsWith("NEXT_PUBLIC_") && value && isPrivilegedSupabaseKey(value))
    .map(([name]) => name);
  if (leaked.length > 0) {
    throw new Error(
      `Refusing to start: privileged Supabase key found in browser-exposed variable(s): ${leaked.join(", ")}. ` +
        "Rotate the key in the Supabase dashboard and move it to a server-only variable.",
    );
  }
}

export function getServerEnv(): ServerEnv {
  if (cached) return cached;
  assertNoSecretsInPublicVariables();
  const result = serverEnvSchema.safeParse({ SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY });
  if (!result.success) {
    throw new Error(`Invalid server environment configuration: ${describeEnvIssues(result.error)}. See .env.example.`);
  }
  if (result.data.SUPABASE_SECRET_KEY === getPublicEnv().NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) {
    throw new Error("Invalid server environment configuration: SUPABASE_SECRET_KEY equals the publishable key.");
  }
  cached = result.data;
  return cached;
}
