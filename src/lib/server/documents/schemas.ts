import { z } from "zod";

import { EXTRACTION_LIMITS, SUPPORTED_MIME_TYPES } from "../../documents/limits.ts";
import { GRADE_LEVELS, LANGUAGES, SLIDE_COUNTS, SUBJECTS, THEMES } from "../../presentation-options.ts";

/**
 * Zod schemas for document Server Action input. Everything the browser sends is re-validated
 * here; declared sizes and MIME types are only accepted as hints and checked again later against
 * Storage metadata and the actual bytes.
 */

const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/;
const values = <T extends { value: string }>(options: readonly T[]) => options.map((option) => option.value) as [string, ...string[]];

export const documentIdSchema = z.uuid();
export const presentationIdSchema = z.uuid();

/** Display name only: directory parts are stripped; it never becomes a storage path. */
const fileNameSchema = z
  .string()
  .max(1024)
  .transform((name) => name.split(/[\\/]/).pop()?.normalize("NFC").trim() ?? "")
  .pipe(
    z
      .string()
      .min(1, "File name is required.")
      .max(255, "File name is too long.")
      .refine((name) => !CONTROL_CHARS.test(name), "File name contains invalid characters."),
  );

export const fileManifestEntrySchema = z
  .object({
    name: fileNameSchema,
    size: z.number().int().min(1).max(EXTRACTION_LIMITS.maxInputBytes),
    /** The browser's MIME type. Empty is allowed (Windows often reports "" for .docx). */
    mimeType: z.string().trim().toLowerCase().max(200).optional().default(""),
  })
  .transform((file, ctx) => {
    const extension = file.name.toLowerCase().match(/\.(pdf|docx)$/)?.[1] as "pdf" | "docx" | undefined;
    if (!extension) {
      ctx.addIssue({ code: "custom", path: ["name"], message: "Only .pdf and .docx files are supported." });
      return z.NEVER;
    }
    const allowed = SUPPORTED_MIME_TYPES[extension] as readonly string[];
    if (file.mimeType !== "" && !allowed.includes(file.mimeType)) {
      ctx.addIssue({ code: "custom", path: ["mimeType"], message: "The file type doesn’t match its extension." });
      return z.NEVER;
    }
    return { name: file.name, size: file.size, kind: extension, contentType: allowed[0] };
  });

export const createDraftInputSchema = z.object({
  title: z
    .string()
    .max(1000)
    .transform((title) => title.replace(/\s+/g, " ").trim())
    .pipe(z.string().min(1, "Title is required.").max(200).refine((title) => !CONTROL_CHARS.test(title))),
  grade: z.union([z.string(), z.number()]).transform(String).pipe(z.enum(values(GRADE_LEVELS))).transform(Number),
  subject: z.enum(values(SUBJECTS)),
  language: z.enum(values(LANGUAGES)),
  theme: z.enum(values(THEMES)),
  slideCount: z.union([z.string(), z.number()]).transform(String).pipe(z.enum(SLIDE_COUNTS)).transform(Number),
  files: z.array(fileManifestEntrySchema).min(1).max(3),
});

export type CreateDraftInput = z.input<typeof createDraftInputSchema>;
export type ValidatedDraft = z.output<typeof createDraftInputSchema>;

/** Field paths of validation issues (never the submitted values). */
export function issueFields(error: z.ZodError): string[] {
  return [...new Set(error.issues.map((issue) => issue.path.join(".") || "(input)"))];
}
