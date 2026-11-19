/**
 * Option lists shared by the presentation creation form and display components.
 * Values are stable identifiers; labels are what teachers see.
 */

export const GRADE_LEVELS = [
  { value: "1", label: "Grade 1" },
  { value: "2", label: "Grade 2" },
  { value: "3", label: "Grade 3" },
  { value: "4", label: "Grade 4" },
  { value: "5", label: "Grade 5" },
  { value: "6", label: "Grade 6" },
] as const;

export const SUBJECTS = [
  { value: "english", label: "English" },
  { value: "filipino", label: "Filipino" },
  { value: "mathematics", label: "Mathematics" },
  { value: "science", label: "Science" },
  { value: "araling-panlipunan", label: "Araling Panlipunan" },
  { value: "mapeh", label: "MAPEH" },
  { value: "esp", label: "Edukasyon sa Pagpapakatao" },
  { value: "epp-tle", label: "EPP / TLE" },
] as const;

export const LANGUAGES = [
  { value: "english", label: "English" },
  { value: "filipino", label: "Filipino" },
  { value: "taglish", label: "Taglish" },
] as const;

export const SLIDE_COUNTS = ["5", "8", "10", "12", "15"] as const;

export type ThemeOption = {
  value: string;
  label: string;
  description: string;
  /** Preview colors used for the theme swatch (hex, matches future PPTX output). */
  colors: {
    background: string;
    title: string;
    accent: string;
    shape: string;
  };
};

export const THEMES: readonly ThemeOption[] = [
  {
    value: "rainbow-classroom",
    label: "Rainbow Classroom",
    description: "Bright, cheerful colors",
    colors: { background: "#FFF8E7", title: "#5B21B6", accent: "#F97316", shape: "#22C55E" },
  },
  {
    value: "ocean-explorer",
    label: "Ocean Explorer",
    description: "Calm blues and teals",
    colors: { background: "#E0F2FE", title: "#0C4A6E", accent: "#0EA5E9", shape: "#14B8A6" },
  },
  {
    value: "jungle-adventure",
    label: "Jungle Adventure",
    description: "Leafy greens and sunshine",
    colors: { background: "#ECFCCB", title: "#14532D", accent: "#65A30D", shape: "#FACC15" },
  },
  {
    value: "space-galaxy",
    label: "Space Galaxy",
    description: "Deep purple with stars",
    colors: { background: "#1E1B4B", title: "#E0E7FF", accent: "#A78BFA", shape: "#FDE047" },
  },
  {
    value: "crayon-box",
    label: "Crayon Box",
    description: "Playful hand-drawn feel",
    colors: { background: "#FFFFFF", title: "#DC2626", accent: "#2563EB", shape: "#F59E0B" },
  },
  {
    value: "calm-chalkboard",
    label: "Calm Chalkboard",
    description: "Classic and focused",
    colors: { background: "#1F3A33", title: "#F8FAFC", accent: "#FDE68A", shape: "#93C5FD" },
  },
] as const;

/** Client-side upload rules. The server must re-validate when uploads are implemented. */
export const UPLOAD_RULES = {
  maxFileSizeBytes: 10 * 1024 * 1024,
  maxFiles: 3,
  acceptedExtensions: [".pdf", ".docx"],
  acceptAttribute:
    ".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document",
} as const;

export function labelFor<T extends { value: string; label: string }>(
  options: readonly T[],
  value: string,
): string {
  return options.find((option) => option.value === value)?.label ?? value;
}
