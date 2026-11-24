"use client";

import { useFormStatus } from "react-dom";
import { LogOut } from "lucide-react";

import { Button } from "@/components/ui/button";

/** Submit button for a `<form action={signOut}>` (works without JavaScript too). */
export function SignOutButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="ghost" size="sm" disabled={pending} className="w-full justify-start">
      <LogOut data-icon="inline-start" />
      {pending ? "Signing out…" : "Sign out"}
    </Button>
  );
}
