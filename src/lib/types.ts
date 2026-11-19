export type GenerationMode = "topic" | "materials";

export type PresentationStatus = "draft" | "generating" | "ready" | "failed";

export type PresentationSummary = {
  id: string;
  title: string;
  grade: string;
  subject: string;
  language: string;
  slideCount: number;
  theme: string;
  mode: GenerationMode;
  status: PresentationStatus;
  /** ISO 8601 timestamp */
  updatedAt: string;
};
