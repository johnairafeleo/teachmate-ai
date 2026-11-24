"use client";

import { useEffect, type RefObject } from "react";

import type { AuthFormState } from "@/lib/auth/schemas";

/**
 * After a failed submit, move focus to the first invalid field (in `order`), or to the form-level
 * alert. Keyboard and screen-reader users land on the problem instead of the submit button.
 */
export function useFocusFirstError<Field extends string>(
  state: AuthFormState<Field>,
  order: readonly { field: Field; id: string }[],
  alertRef: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (state.status !== "error") return;
    const first = order.find(({ field }) => state.fieldErrors?.[field]);
    if (first) document.getElementById(first.id)?.focus();
    else alertRef.current?.focus();
    // Run once per new state object (each submit returns a fresh one).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);
}
