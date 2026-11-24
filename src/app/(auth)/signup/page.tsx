import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AuthCard, AuthFormSkeleton } from "@/components/auth/auth-card";
import { SignupForm } from "@/components/auth/signup-form";
import { getCurrentUser } from "@/lib/auth/dal";

export const metadata: Metadata = {
  title: "Create account",
};

export default function SignupPage() {
  return (
    <AuthCard
      title="Create your account"
      description="Free for teachers. Turn any lesson into classroom-ready slides."
      footer={
        <>
          Already have an account?{" "}
          <Link href="/login" className="font-semibold text-primary underline-offset-4 hover:underline">
            Log in
          </Link>
        </>
      }
    >
      <Suspense fallback={<AuthFormSkeleton fields={3} />}>
        <SignupContent />
      </Suspense>
    </AuthCard>
  );
}

async function SignupContent() {
  if (await getCurrentUser()) redirect("/dashboard");
  return <SignupForm />;
}
