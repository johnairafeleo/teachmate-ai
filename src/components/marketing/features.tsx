import {
  BookOpenCheck,
  Download,
  GraduationCap,
  Languages,
  Palette,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";

type Feature = { icon: LucideIcon; title: string; body: string; color: string };

const FEATURES: Feature[] = [
  {
    icon: GraduationCap,
    title: "Grade-appropriate",
    body: "Vocabulary and pacing tuned for Grade 1 through Grade 6 learners.",
    color: "text-violet-600 bg-violet-100",
  },
  {
    icon: Languages,
    title: "English, Filipino, Taglish",
    body: "Teach in the language your class understands best.",
    color: "text-sky-600 bg-sky-100",
  },
  {
    icon: Palette,
    title: "Kid-friendly themes",
    body: "Bright, classroom-inspired designs that keep young eyes on the board.",
    color: "text-pink-600 bg-pink-100",
  },
  {
    icon: BookOpenCheck,
    title: "Grounded in your materials",
    body: "Upload modules or lesson plans. Missing information is flagged, never made up.",
    color: "text-emerald-600 bg-emerald-100",
  },
  {
    icon: ShieldCheck,
    title: "You stay in control",
    body: "Review and edit every slide before you export anything.",
    color: "text-amber-600 bg-amber-100",
  },
  {
    icon: Download,
    title: "Real PowerPoint files",
    body: "Download an editable .pptx that works on any classroom computer.",
    color: "text-indigo-600 bg-indigo-100",
  },
];

export function Features() {
  return (
    <section id="features" className="scroll-mt-20">
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 md:py-24">
        <div className="max-w-2xl">
          <h2 className="text-3xl font-semibold sm:text-4xl">Built for real classrooms</h2>
          <p className="mt-3 text-lg text-muted-foreground">
            Less time formatting slides. More time teaching.
          </p>
        </div>
        <ul className="mt-12 grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature) => (
            <li key={feature.title} className="flex gap-4">
              <span
                aria-hidden="true"
                className={`flex size-11 shrink-0 items-center justify-center rounded-xl ${feature.color}`}
              >
                <feature.icon className="size-5" />
              </span>
              <div>
                <h3 className="font-sans text-base font-semibold tracking-normal">{feature.title}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{feature.body}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
