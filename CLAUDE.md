# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Commands

Package manager is **npm**.

```bash
npm run dev        # dev server (Turbopack) on http://localhost:3000
npm run build      # production build — also runs the TypeScript check
npm run lint       # ESLint (flat config, eslint-config-next); `next lint` no longer exists in Next 16
npx tsc --noEmit   # type-check only (run `npx next typegen` first if PageProps/LayoutProps types are missing)
npx shadcn@latest add <component>   # add a shadcn/ui component into src/components/ui
```

There is no test framework yet, so there is no single-test command.

## Project Overview

TeachMate AI helps elementary teachers (Grades 1–6) generate classroom slide presentations. Teachers either describe a topic or upload their own reference material, review and edit the AI-generated slides, and export them as PowerPoint (PPTX) files.

Core stack named in the requirements:

- **Supabase**: authentication, database, and private Storage for uploaded materials
- **OpenAI**: AI content generation
- **Zod**: validation of structured AI output
- **PptxGenJS**: PowerPoint file generation

## Engineering Guidelines

- Next.js App Router, TypeScript strict mode, Tailwind CSS v4 (tokens in `src/app/globals.css`, no `tailwind.config`).
- Server Components by default; add `"use client"` only where interactivity is needed.
- Use shadcn/ui components where appropriate and Lucide for icons.
- Avoid unnecessary dependencies. Do not introduce Prisma.
- Design: modern educational SaaS, friendly but professional, purple/blue accents, responsive, accessible form controls.

## Architecture

### Next.js 16 specifics (see AGENTS.md)

- `next.config.ts` enables `cacheComponents` and `partialPrefetching`. Any read of request data (e.g. `await searchParams`) must sit inside a `<Suspense>` boundary or the build fails. The pages do this by having a sync page component render an async child inside `<Suspense>` (see `src/app/dashboard/page.tsx` and `src/app/dashboard/create/page.tsx`).
- Route props use the generated global types `PageProps<"/route">` / `LayoutProps<"/route">`; `searchParams` is a Promise.

### shadcn/ui is built on Base UI, not Radix

`components.json` uses the `base-nova` style, so `src/components/ui/*` wraps `@base-ui/react`:

- No `asChild`. Compose with the `render` prop (e.g. `<SheetTrigger render={<Button … />}>`). For links styled as buttons, put `buttonVariants(...)` on `<Link className>` instead.
- Active/checked state attributes are `data-active`, `data-checked`, `data-open`, not Radix's `data-state`.
- `Select` needs `items` on the root so `SelectValue` shows labels, and its `onValueChange` can emit `null`.
- `cn` comes from the `cn` package (re-exported by `src/lib/utils.ts`), not clsx + tailwind-merge.
- Some generated components (e.g. Badge, which uses `useRender`) call hooks without `"use client"`. Don't use those from Server Components.
- Custom radio-style controls (`src/components/create/choice-group.tsx`, `theme-picker.tsx`) use `@base-ui/react/radio` primitives directly.

### Source layout

- `src/app/`: routes. `/` is the landing page; `/dashboard` has a layout with a fixed desktop sidebar and a mobile Sheet nav; `/dashboard/create` is the creation form.
- `src/components/{marketing,dashboard,create,presentation,brand}/`: feature components. `presentation/slide-preview.tsx` renders a theme's colors as a 16:9 thumbnail and is reused across the landing page, dashboard cards, theme picker and form summary.
- `src/lib/presentation-options.ts`: the single source for grades, subjects, languages, slide counts, themes (with hex colors meant to match future PPTX output) and `UPLOAD_RULES`. Add options here, not in components.
- `src/lib/mock-data.ts`: mock teacher and presentations; to be replaced by Supabase queries. `/dashboard?view=empty` exists only to preview the empty state.

### Create-presentation form

`src/components/create/create-presentation-form.tsx` is the one stateful client component. Mode A and Mode B are Base UI Tabs panels holding the mode-specific inputs (topic/objectives vs. files). Class settings and theme are shared state outside the tabs, so they persist across mode switches. Validation runs on submit and focuses the first invalid field by id. `?mode=materials` selects the initial mode, and the form is keyed by mode so navigation resets it. Submit is currently a placeholder timer; no AI or upload calls exist yet.

`src/lib/file-validation.ts` checks extension, empty file, the 10 MB limit and the file signature (`%PDF-` / ZIP `PK\x03\x04`) on the client. This is a UX pre-check only; server-side validation is still required (see Mode B below).

## Content Generation Modes

TeachMate AI must support two generation modes.

### Mode A: Topic-Based Generation

Teachers provide:

- Grade level (Grade 1–6)
- Subject
- Lesson topic
- Learning objectives (optional)
- Language (English, Filipino, Taglish)
- Desired slide count
- Presentation theme

The AI generates educational slide content based on the topic.

### Mode B: Reference Material-Based Generation

Teachers can upload:

- PDF files
- DOCX files

The system extracts text from uploaded materials and uses that content as the primary reference for presentation generation.

Requirements:

- Validate file extensions **and** actual file types (inspect file contents / magic bytes).
- Enforce an upload size limit of **10 MB per file** for the initial MVP.
- Reject unsupported and empty files.
- Never trust filenames or client-provided MIME types alone.
- Keep uploaded materials in **private** Supabase Storage.
- Never expose private storage credentials (e.g. the service role key) to the client.
- Process documents on the server.
- Do not send unnecessary personal or sensitive information to AI providers.
- Clearly indicate when information is missing from uploaded materials.
- Do not silently invent facts or claim that unsupported information came from the source.
- Allow teachers to review generated content before exporting.

### Generation Architecture

Separate the application into these responsibilities:

1. Document processing
2. AI content generation
3. Slide content validation
4. Presentation rendering
5. PPTX export

Rules:

- The AI must return structured JSON validated with Zod. Reject or repair invalid output; never render unvalidated AI output.
- PptxGenJS handles the actual PowerPoint file generation.
- Keep uploaded document content, generated slide content, and exported PPTX files separate (separate storage and data models).

## MVP Priority

Build in this order:

1. Application foundation and dashboard
2. Presentation creation UI with both generation modes
3. Supabase authentication and database
4. Secure document upload and text extraction
5. OpenAI integration
6. PowerPoint generation
7. Preview and editing
8. Presentation history

### Out of Scope (for now)

- Payments
- Subscriptions
- Advanced agent workflows

## Working Process

- Do not implement all features in one task.
- Work one development phase at a time, following the MVP priority order.
- Stop and wait for approval before starting the next phase.
