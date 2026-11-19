import { FileUp, Lightbulb, type LucideIcon } from "lucide-react";

type Mode = {
  icon: LucideIcon;
  eyebrow: string;
  title: string;
  description: string;
  steps: string[];
  tone: string;
};

const MODES: Mode[] = [
  {
    icon: Lightbulb,
    eyebrow: "Mode A",
    title: "Create from a topic",
    description:
      "Tell us the grade, subject, and lesson topic. TeachMate AI drafts age-appropriate slides around your objectives.",
    steps: ["Pick a grade and subject", "Describe your lesson topic", "Choose language, length, and theme"],
    tone: "bg-accent text-accent-foreground",
  },
  {
    icon: FileUp,
    eyebrow: "Mode B",
    title: "Create from your materials",
    description:
      "Upload a PDF or Word file — a module, lesson plan, or reading. Slides are built from your material, and gaps are flagged instead of invented.",
    steps: ["Upload a PDF or DOCX", "Set grade, language, and length", "Review what came from your source"],
    tone: "bg-secondary text-secondary-foreground",
  },
];

const STEPS = [
  { title: "Describe or upload", body: "Start from a topic or from your own learning materials." },
  { title: "Review and edit", body: "Check every slide before anything is exported." },
  { title: "Download PowerPoint", body: "Get a .pptx file ready for your classroom TV or projector." },
];

export function GenerationModes() {
  return (
    <section id="how-it-works" className="scroll-mt-20 border-y border-border/60 bg-card">
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 md:py-24">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-semibold sm:text-4xl">Two ways to start a lesson</h2>
          <p className="mt-3 text-lg text-muted-foreground">
            Whether you have a blank page or a stack of modules, TeachMate AI meets you where you are.
          </p>
        </div>

        <div className="mt-12 grid gap-6 md:grid-cols-2">
          {MODES.map((mode) => (
            <article key={mode.title} className="rounded-2xl border border-border bg-background p-6 sm:p-8">
              <div className={`inline-flex size-12 items-center justify-center rounded-xl ${mode.tone}`}>
                <mode.icon className="size-6" aria-hidden="true" />
              </div>
              <p className="mt-5 text-sm font-semibold tracking-wide text-primary uppercase">{mode.eyebrow}</p>
              <h3 className="mt-1 text-2xl font-semibold">{mode.title}</h3>
              <p className="mt-3 text-muted-foreground">{mode.description}</p>
              <ol className="mt-6 space-y-3">
                {mode.steps.map((step, index) => (
                  <li key={step} className="flex items-center gap-3 text-sm font-medium">
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs text-muted-foreground">
                      {index + 1}
                    </span>
                    {step}
                  </li>
                ))}
              </ol>
            </article>
          ))}
        </div>

        <ol className="mt-12 grid gap-6 sm:grid-cols-3">
          {STEPS.map((step, index) => (
            <li key={step.title} className="flex gap-4">
              <span className="font-heading text-3xl font-semibold text-primary/80">0{index + 1}</span>
              <div>
                <p className="font-semibold">{step.title}</p>
                <p className="mt-1 text-sm text-muted-foreground">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
