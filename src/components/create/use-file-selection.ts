"use client";

import { useCallback, useReducer } from "react";

import type { FileCheckResult, SupportedFileKind } from "@/lib/file-validation";
import { UPLOAD_RULES } from "@/lib/presentation-options";

export type SelectedFile = {
  /** Client-side list identity only — not a security token. */
  id: string;
  file: File;
  kind: SupportedFileKind;
};

export type FileMessage = { id: number; text: string };

/** A file that has already been through the async content checks. */
export type CheckedFile = { file: File; result: FileCheckResult };

type State = {
  files: SelectedFile[];
  messages: FileMessage[];
  /** Monotonic counter for file and message ids (works without crypto.randomUUID / secure contexts). */
  nextId: number;
};

type Action =
  | { type: "add"; candidates: CheckedFile[] }
  | { type: "remove"; id: string }
  | { type: "clear-messages" };

const fileKey = (file: File) => `${file.name}:${file.size}:${file.lastModified}`;

/**
 * Pure reducer: duplicate and file-limit checks always run against the latest
 * committed state, so overlapping selections or drops can never exceed the limit.
 */
function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "add": {
      let nextId = state.nextId;
      const files = [...state.files];
      const keys = new Set(files.map((selected) => fileKey(selected.file)));
      const texts: string[] = [];
      const overLimit: string[] = [];

      for (const { file, result } of action.candidates) {
        if ("error" in result) {
          texts.push(result.error);
        } else if (keys.has(fileKey(file))) {
          texts.push(`“${file.name}” is already added.`);
        } else if (files.length >= UPLOAD_RULES.maxFiles) {
          overLimit.push(`“${file.name}”`);
        } else {
          keys.add(fileKey(file));
          files.push({ id: `file-${nextId++}`, file, kind: result.kind });
        }
      }

      if (overLimit.length > 0) {
        texts.push(
          `You can add a maximum of ${UPLOAD_RULES.maxFiles} files. Remove a file to add another. Not added: ${overLimit.join(", ")}.`,
        );
      }

      const messages = [...state.messages];
      for (const text of texts) messages.push({ id: nextId++, text });
      return { files, messages, nextId };
    }
    case "remove":
      return { ...state, files: state.files.filter((selected) => selected.id !== action.id), messages: [] };
    case "clear-messages":
      return state.messages.length === 0 ? state : { ...state, messages: [] };
  }
}

const INITIAL_STATE: State = { files: [], messages: [], nextId: 1 };

export function useFileSelection() {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);

  const add = useCallback((candidates: CheckedFile[]) => dispatch({ type: "add", candidates }), []);
  const remove = useCallback((id: string) => dispatch({ type: "remove", id }), []);
  const clearMessages = useCallback(() => dispatch({ type: "clear-messages" }), []);

  return { files: state.files, messages: state.messages, add, remove, clearMessages };
}

export type FileSelection = ReturnType<typeof useFileSelection>;
