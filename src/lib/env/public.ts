import { z } from "zod";

/**
 * Public environment variables. These are inlined into the browser bundle at BUILD time,
 * so each one must be read with a literal `process.env.NEXT_PUBLIC_*` reference.
 * Values are validated lazily (on first use), so pages that don't touch Supabase keep working
 * before Supabase is configured.
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** https everywhere except local development hosts. */
const httpUrl = z.url({ protocol: /^https?$/ }).refine(
  (value) => {
    const url = new URL(value);
    return url.protocol === "https:" || LOCAL_HOSTS.has(url.hostname);
  },
  { message: "must use https (http is only allowed for localhost)" },
);

/** Decode a JWT payload without verifying it — used only to detect a misplaced service_role key. */
function jwtRole(token: string): string | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload: unknown = JSON.parse(atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=")));
    return typeof payload === "object" && payload !== null && "role" in payload ? String(payload.role) : undefined;
  } catch {
    return undefined;
  }
}

/** True when a value is a server-only Supabase key (new secret key or legacy service_role JWT). */
export function isPrivilegedSupabaseKey(value: string): boolean {
  return value.startsWith("sb_secret_") || jwtRole(value) === "service_role";
}

const publicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: httpUrl,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z
    .string()
    .trim()
    .min(20, "is missing or too short")
    .refine((key) => !isPrivilegedSupabaseKey(key), {
      message: "is a SECRET/service_role key — never expose it in a NEXT_PUBLIC_ variable",
    }),
  NEXT_PUBLIC_SITE_URL: httpUrl,
});

export type PublicEnv = z.infer<typeof publicEnvSchema>;

let cached: PublicEnv | undefined;

/** Lists problems by variable name only — never echoes values. */
export function describeEnvIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "(env)"} ${issue.message}`).join("; ");
}

/** Validate without throwing (used by the proxy so a misconfiguration never takes the site down). */
export function readPublicEnv(): { ok: true; env: PublicEnv } | { ok: false; message: string } {
  if (cached) return { ok: true, env: cached };
  const result = publicEnvSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
  });
  if (!result.success) return { ok: false, message: describeEnvIssues(result.error) };
  cached = result.data;
  return { ok: true, env: cached };
}

/** Validated public env; throws a descriptive error (without values) when misconfigured. */
export function getPublicEnv(): PublicEnv {
  const result = readPublicEnv();
  if (!result.ok) {
    throw new Error(`Invalid public environment configuration: ${result.message}. See .env.example.`);
  }
  return result.env;
}
