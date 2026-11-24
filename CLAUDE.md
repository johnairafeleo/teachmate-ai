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

```bash
npm test                                   # node:test over src/**/*.test.ts (Node 24 runs TypeScript directly)
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test src/lib/documents/tests/docx.test.ts   # one file
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON src/lib/documents/tests/measure-runner.ts pdf-50-pages   # timing/RSS
npm run test:integration                   # *.itest.ts against the HOSTED DEV project (refuses any other ref); creates and deletes disposable users
```

Code run by `node --test` must avoid `@/` aliases, import with explicit `.ts` extensions (`allowImportingTsExtensions` is on), use `import type` for types, and stick to erasable TypeScript (no enums, namespaces or parameter properties).

Environment: copy `.env.example` to `.env.local` and fill in the **development** project's URL (`https://<ref>.supabase.co`) and keys. Variables are validated lazily with Zod in `src/lib/env/{public,server}.ts`; the app refuses a secret/service_role key in any `NEXT_PUBLIC_*` variable.

### Supabase workflow (hosted development project, no Docker)

There is no local Supabase stack and Docker is not required. Development runs against the hosted project **`teachmate-ai-dev`** (ref `gceuqyhuxpmnkmhhaivr`). `supabase/.temp/` holds the link and is git-ignored. `npx supabase start/status/stop/db reset` (local stack) do not apply.

```bash
npx supabase login                                        # once per machine (browser flow)
npx supabase link --project-ref gceuqyhuxpmnkmhhaivr      # type the DB password in your own terminal only
npx supabase projects list                                # confirm which project is "linked": true
npx supabase migration new <name>                         # creates supabase/migrations/<timestamp>_<name>.sql
npx supabase migration list --remote                      # read-only: local vs. applied migrations
npx supabase db push --remote --skip-vault --dry-run      # read-only preview of what would be applied
```

In CLI v3, `db push` and `migration list` target the **local** database unless `--remote` is passed (`--linked` is deprecated). The CLI labels every hosted project `production`; that label does not mean it is the production app.

Rules:

- Schema changes go through migration files in `supabase/migrations/` and the CLI only. Never change schema, auth or storage settings in the dashboard or with ad-hoc SQL.
- Before targeting any hosted project, confirm the linked ref is `gceuqyhuxpmnkmhhaivr` and matches `NEXT_PUBLIC_SUPABASE_URL`. **Never target a production project without explicit approval.** Other projects in the same Supabase organization are unrelated; never link to them.
- **Always dry-run first, and get explicit approval before** `db push` (without `--dry-run`), `db reset`, `migration repair`, `migration squash`, or any SQL that drops, truncates, deletes or alters existing data. Applied migrations are never edited; fix forward with a new migration.
- `db push` applies each migration file atomically, but earlier files stay applied if a later one fails.
- Never paste or print the DB password, access token or `SUPABASE_SECRET_KEY`.

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

### Supabase clients (`src/lib/supabase/`)

- `server.ts`: user-scoped client for Server Components/Actions/Route Handlers (publishable key + cookies, RLS applies). Create per request; it calls `connection()` and reads `cookies()`, so call it inside `<Suspense>` and never in `use cache`. `connection()` keeps it out of runtime-prefetch prerenders, where the auth client's clock reads fail.
- `client.ts`: browser client; keep browser use minimal (planned: signed-URL uploads only).
- `proxy.ts` + `src/proxy.ts`: Next 16 Proxy refreshes the session via `getClaims()` and forwards Supabase's no-store cache headers. It skips requests without `sb-*` auth cookies and never blocks the site on misconfiguration. On GET/HEAD only, it makes optimistic redirects: signed-out or expired sessions on `/dashboard/**` go to `/login?next=…` (with `notice=session_expired` when a cookie existed), and signed-in users skip `/login` and `/signup`. It is not an authorization check.
- `admin.ts`: **secret key, bypasses RLS.** ESLint only allows importing it from `src/lib/server/**`. Use it only to call `svc_*` database functions and for server-side Storage operations, always scoped by a user id from verified claims (`getClaims()`, or `getUser()` for destructive actions), never from request input.
- Identity on the server comes from `getClaims()`/`getUser()`, never `getSession()`.
- `supabase/config.toml` records the intended auth settings (email confirmation on, 8-char passwords, redirect URLs), but it only configures a local stack, which we don't run. `db push` does not apply them to the hosted project; mirror them in the dashboard, and only with approval.

### Authentication (`src/lib/auth/`)

- `dal.ts` (server-only) is the one place that decides who the user is. Use `getCurrentUser()` for verified JWT claims or null; `requireUser()` redirects to `/login`; `getCurrentProfile()` adds `full_name` from `profiles`, read through RLS. Use `requireVerifiedUser()` (an Auth-server `getUser()` round trip) before destructive or sensitive operations, signed Storage URLs and `svc_*` calls. Results are memoised per request with React `cache()`. Never use `use cache`/`use cache: private` for identity, because a cached identity outlives sign-out.
- Every protected page calls `requireUser()` inside its `<Suspense>` child. A layout-level check isn't enough, because layouts don't re-render on client navigation. Every Server Action that touches user data must re-check identity itself.
- `actions.ts` (`"use server"`): `signIn`, `signUp`, `resendConfirmation`, `signOut` (scope `local`). They use the user-scoped client, never the admin client.
  - Every input is validated with Zod (`schemas.ts`).
  - Provider errors map to fixed copy. Only error codes are logged.
  - Signing up with an existing address gives the same response as a new sign-up, so accounts can't be enumerated.
  - `emailRedirectTo` comes from `NEXT_PUBLIC_SITE_URL`, never from request headers.
- `redirect.ts`: `safeNextPath()` limits `?next=` to normalised `/dashboard/**` paths, which blocks open redirects. `isProtectedPath()` is shared by the proxy.
- `messages.ts`: `?notice=` and `?error=` codes map to fixed copy, and unknown codes render nothing.
- `src/app/auth/confirm/route.ts` handles both link styles: `token_hash`+`type`, via `verifyOtp`, and PKCE `code`, via `exchangeCodeForSession`. It also handles Supabase's `?error_code=` redirects. Only `email`/`signup` types are accepted. Responses are same-origin 303s with `no-store`.
- Pages: `src/app/(auth)/{login,signup}` share `(auth)/layout.tsx`. Form components live in `src/components/auth/`. The forms use `useActionState` and focus the first invalid field. With JavaScript disabled the actions still run and redirect, but error state isn't rendered into the HTML.
- Hosted Auth settings (Site URL, redirect allow-list, email template) live in the dashboard, not in migrations.

### Document extraction engine (`src/lib/documents/`)

- `extractDocument(bytes, "pdf" | "docx", { deadlineMs?, mimeType? })` takes the stored type and returns `{ text, page_count, total_pages, is_truncated, extractor_version }`, or throws `ExtractionError` with a fixed `code` (user-safe message) and a log-only `reason`. It's pure: no Supabase, Next.js, filesystem or network. It's called by the document service; it's verified to work inside the Next.js 16 Turbopack server bundle without `serverExternalPackages`.
- **PDF:** `unpdf@2.1.0`, which bundles PDF.js 6.4.299 with no eval/`new Function` paths. Reads pages 1..min(n, 50) one at a time and stops early at the character cap. Text only: no fonts, WASM, XFA or fetches.
- **DOCX:** a bounded ZIP reader in `zip.ts` (central directory checked first; ≤1,000 entries, ≤50 MiB declared, ratio ≤100:1) inflates only `[Content_Types].xml` and `word/document.xml` (≤20 MiB) with `fflate@0.8.3`. Limits are enforced on the actual inflated bytes and CRCs are verified. XML with DOCTYPE/ENTITY is rejected; the text walker is prefix-aware and never expands entities.
- Text is NFC, with controls, bidi, zero-width and tag characters removed, then cut to 100,000 characters; <20 letters/digits gives `NO_TEXT` (no OCR).
- **CPU isolation** (`isolated-extract.ts`, `worker/extract-worker.ts`, `worker/protocol.ts`): the app calls `extractDocumentIsolated()`, never `extractDocument()` directly. Each extraction runs in a fresh, single-use `worker_threads` worker.
  - **Hard deadline:** the parent terminates the worker at deadline + 1.5 s, which stops even a synchronous loop.
  - **Heap:** V8 `resourceLimits` per worker (256 MiB old / 48 MiB young generation); running out of heap gives `LIMITS_EXCEEDED` (`worker_memory`). **This does not cap ArrayBuffers/external memory.** PDF.js decodes a compressed content stream into one growing ArrayBuffer: a 1.48 MiB PDF reached +3.1 GiB RSS with only heap limits (TASK 005.7.1).
  - **RSS watchdog** (`MEMORY_LIMITS`): the parent samples `process.memoryUsage.rss()` every 20 ms while a worker runs (the whole process, so other requests on the instance count too) and terminates the worker when RSS > 1,280 MiB (`process_memory`) or more than 512 MiB above the RSS measured when the worker started (`memory_growth`; the baseline is never assumed to be zero). Admission: above 768 MiB (= 1,280 − 512) no extraction starts. The service checks this exactly once, **before** the claim, and answers retryable `SERVER_BUSY`; it then passes `admissionChecked: true`, so `extractDocumentIsolated()` does not check again after the claim. Before TASK 005.7.3 a second check there could permanently fail a claimed document as `TIMEOUT` when memory rose during the claim round trip; a regression test covers this. Direct callers that don't pass the flag get `TIMEOUT`/`memory_busy`, and no worker is started.
  - **Memory numbers:** Vercel documents 2 GB for Hobby functions (fixed); that is the only platform figure, and how Vercel measures it and handles OOM is undocumented. Everything else here was **measured locally** (Windows, Node 24.21) and is not a Vercel measurement:
    - `next start` server: ~160 MiB RSS (peak 182 MiB after the browser e2e run);
    - `next dev`: ~550 MiB, peaking at 1.66 GB while compiling, so during dev a document can get `SERVER_BUSY` or even a `process_memory` failure;
    - ordinary documents: +20–180 MiB (18 MiB document.xml +120 MiB; dense 8 MiB PDF page +180 MiB);
    - a PDF that inflates to 1 GiB is stopped at +480–520 MiB within ~4 s;
    - with the watchdog off, a 300 MiB-decoding PDF completes at +570 MiB.
  - **Memory attribution** (TASK 005.7.5 spike, implemented in 005.7.6): RSS is process-wide and can't say who grew, so the parent also polls `worker.getHeapStatistics()` (`used_heap_size + external_memory`, the worker isolate's own heap and ArrayBuffers).
    - **Polling:** starts on the worker's `online` event, one call in flight, every 20 ms, keeping the **peak**. Rejected, throwing or never-answering calls are ignored; polling never delays or disables the RSS watchdog and stops in `finish()`.
    - **Classification** when the watchdog fires:
      - peak ≥ 256 MiB (`documentAttributionBytes`): the document's fault → `ExtractionError LIMITS_EXCEEDED` (permanent);
      - peak < 256 MiB, or no sample (`attribution: "unavailable"`): shared pressure → `MemoryPressureError`. The service releases the document (retryable `SERVER_BUSY`), at most twice.
    - **Measured locally:** ordinary documents peak at 28–158 MiB; a 1 GiB-decoding PDF passes 256 MiB ~0.7 s before the growth limit fires; 640 MiB allocated by the parent doesn't appear in the worker's numbers.
    - `MemoryPressureError` carries only `trigger`, `attribution` and `workerPeakBytes`; it isn't an `ExtractionError` and has no user-facing message of its own.
  - **Watchdog limitations:**
    - It samples, so a single allocation between samples can overshoot. PDF.js grows buffers by doubling, which is why the absolute ceiling sits 768 MiB below 2 GB.
    - `external_memory` counts an ArrayBuffer's allocated size (RSS grows only as pages are written), so right after a doubling it over-reports. Ordinary documents stay ~100 MiB below the threshold.
    - **False "shared" verdict:** if other requests add a lot of memory quickly while a bomb runs, the growth limit can fire before the bomb's own memory reaches 256 MiB (seen in a unit test with +256 MiB of parent memory within 0.3 s). The bomb is then released; the cap of 2 releases makes the third attempt permanent (`SERVER_CAPACITY`).
    - Stats are polled, so a sample can be 20–50 ms old, longer during a single long native call. Worker memory outside V8 (thread stack, code) isn't counted.
  - **No secrets:** the worker's environment contains only `NODE_ENV`, and its input is only bytes plus plain parameters.
  - **Buffer:** transferred, not copied, when `transfer: true`.
  - **Reply:** exactly one, validated with Zod. Crash, exit, invalid reply, timeout or abort each become a fixed `ExtractionError` and go through the normal failure recording.
  - **PDF.js unhandled rejections** stay inside the worker.
  - **Concurrency:** 1 worker per process (`WORKER_LIMITS.maxConcurrentWorkers`; Hobby has 1 vCPU and Fluid compute shares instances, so a second worker would split the CPU and double the memory at risk). Not environment-configurable. The document service takes a slot **before** claiming a document, so a saturated instance answers `SERVER_BUSY` (retryable) and the document stays `uploaded`.
  - **Bundling:** Turbopack recognises `new Worker(new URL("./worker/extract-worker.ts", import.meta.url))` and emits a `[worker thread]` chunk that's included in the route's `.nft.json` trace. Keep that exact expression form.
  - **Tests:** `tests/isolation.test.ts` uses `tests/fault-worker.ts`, test-only and selected by the input bytes, to simulate hang, crash, exit, invalid replies, out-of-memory and slow workers.
    - Memory tests use `flateBombPdf(n)` (a valid PDF, ~1 KiB per MiB decoded, built instantly from repeated `Z_FULL_FLUSH` blocks) and a fake `readRss` / `readWorkerBytes` via the test-only `memory` option.
    - `server/documents/tests/isolation.itest.ts` runs the real worker with a dense PDF and a bomb through the service.

### Document service and Server Actions (`src/lib/server/documents/`, `src/app/dashboard/create/actions.ts`)

- `service.ts` holds the core logic. It takes an explicit context `{ userId, db, admin }` and is marked `server-only`; a Client Component importing it fails the build (verified). The Node integration tests run it with `--conditions=react-server`, which resolves `server-only` to an empty module. `index.ts` (`server-only`) builds the context from the DAL: `requireVerifiedUser()` for mutations, `requireUser()` for reads. The user-scoped client always comes from the same request. `errors.ts`, `schemas.ts` and `storage-errors.ts` are pure and hold no secrets.
- **Time budget** (`PROCESSING_BUDGET` in `service.ts`): one `processDocument` request has 45 s; the routes' `maxDuration` is 60.
  - **Start:** the clock starts before authentication. `processDocumentForCurrentUser` calls `processDocumentAuthenticated(verifiedContext, id)`, which takes `deadlineAt` before awaiting `verifiedContext()` (`requireVerifiedUser()` → `getUser()`). A hosted test shows that a 5 s authentication consumes the same budget.
  - **Reserve:** 10 s is always kept for saving or recording a failure.
  - **Extraction deadline:** min(20 s, time left − 10 s − 1.5 s grace). If less than 3 s would remain, nothing is claimed and the action returns retryable `SERVER_BUSY`; if the download can't start in time, `STORAGE_UNAVAILABLE`. The slot wait shrinks the same way.
  - **Request timeouts:** every PostgREST/RPC call (`.abortSignal`) and the Storage download (`{ signal }`) gets an `AbortSignal.timeout(min(10 s, time left))` that aborts the real fetch, including the body read. There is no `Promise.race`.
  - **Calls without a signal:** Storage `exists()`/`remove()` are skipped when no time is left (`cleanupPending`). Every Supabase client in the app (`server.ts`, `admin.ts`) uses `fetchWithTimeout` (`src/lib/supabase/fetch-timeout.ts`, 10 s per request), which also bounds Auth calls.
  - **Worst case:** 45 + 10 = 55 s.
  - **Stale recovery:** a killed request still leaves `processing`, recovered after 120 s. Keep the stale threshold above `maxDuration`.
- **Attempt tokens and retryable releases** (migration `20261123000800_retryable_processing.sql`):
  - **Columns:** `processing_attempt uuid` and `memory_release_count smallint` (0–2). A check constraint allows a token only while `processing`, and the trigger `source_documents_clear_attempt` clears it on every transition out of `processing`.
  - **Claim:** `svc_claim_document_processing` returns a fresh token. After the claim the service uses only the token-scoped `svc_save_document_extract_attempt`, `svc_fail_document_attempt` and `svc_release_document_processing`.
  - **Release outcomes:** `released` (→ `uploaded`, count + 1), `cap_reached` (third time → `failed` `SERVER_CAPACITY`) or `not_current` (anything else, including the same token again after a lost response). Concurrent calls serialise on the row lock.
  - **Legacy functions** keep their signatures, for old app instances: `svc_save_document_extract` only saves a token-less attempt, and `svc_fail_document` only fails a token attempt that hasn't changed for 2 minutes (database clock; longer than `maxDuration`). So stale recovery (120 s, app clock) and maintenance (15 min) still work but can never fail a live worker, whatever the clock skew.
  - **Service after a `MemoryPressureError`:** release (2 tries); on `released` return `uploaded` + `SERVER_BUSY` and keep the file. For anything else, a fresh owner-scoped read decides: `uploaded` → `SERVER_BUSY`; still our attempt → retryable `INTERNAL_ERROR` with nothing touched; `failed` → cleanup after that confirmed read; a newer attempt → `PROCESSING_IN_PROGRESS`. It never falls back to the unscoped fail.
  - **Quotas:** a release changes none (`uploaded` and `processing` count the same, `file_size` is untouched). The counter isn't writable by teachers: there's no UPDATE grant, and the INSERT grant is limited to 4 columns.
  - **UI:** `SERVER_BUSY` says the upload is safe and offers the manual **Try again**; `SERVER_CAPACITY` is final (upload again later). There is no automatic retry.
  - **Status (2026-11-24):** the migration is **drafted, not applied**. It passes on embedded PostgreSQL 17.12, and a dry run against teachmate-ai-dev lists only this file. Until it is applied, the new service code can't run against the hosted project (it selects the new columns and calls the new RPCs). Apply the migration before deploying this code.
  - **Tests:** `isolation.itest.ts` and `maintenance.itest.ts` have hosted tests for this; `reliability.itest.ts` now waits out the 2-minute window.
- **Failure recording:** `svc_fail_document` (before a claim) or `svc_fail_document_attempt` (after it) is retried, and afterwards a fresh owner-scoped read decides what happens. Only if that read shows `failed` is the object deleted. If the failure wasn't recorded, the action returns `{ ok: false, INTERNAL_ERROR (retryable) }`, never an ordinary status. A row left in `processing` for more than 120 s is treated as abandoned and recorded as failed on the next call.
- **Storage errors** (`storage-errors.ts`; shapes observed on the hosted project): Storage answers almost everything with HTTP 400 and `statusCode` "404", and returns `NoSuchKey` for objects the caller can't read as well as for missing ones. An upload counts as missing only when the download says `NoSuchKey` **and** a service-role `exists()` also says missing. Everything else (`NoSuchBucket` for invalid JWTs, `InvalidKey`, 5xx, network) is retryable and never leads to deletion.
- **Actions** (`"use server"`, thin; `unstable_rethrow` keeps DAL redirects working):
  - `createMaterialsDraftAction(input)`: Zod-validated input → `create_materials_draft` (atomic). The RPC returns no presentation id, so the service reads it back through RLS. Returns `{ presentationId, bucket, uploads[] }` with `contentType` for `file.slice(0, size, contentType)`.
  - `processDocumentAction(documentId)` (idempotent):
    1. read the row through RLS (no row → NOT_FOUND; no session → UNAUTHENTICATED);
    2. `svc_mark_document_verified`;
    3. **download while still `uploaded`**: transient failures and short reads stay retryable, because there's no SQL path back from `processing`;
    4. memory admission and the time check, then the atomic `svc_claim_document_processing` claim, which returns the attempt token (concurrent callers lose and get a status);
    5. `extractDocumentIsolated` with the stored MIME type;
    6. `svc_save_document_extract_attempt`;
    7. on failure: `svc_fail_document_attempt(code)`, re-read the row, and delete the object only if the row really is `failed`; on shared memory pressure, `svc_release_document_processing` (see above).
  - `getPresentationDocumentsAction(presentationId)`: per-file status, extract summary and quota, read through RLS.
- Results are `{ ok: true, data } | { ok: false, error: SafeError }`, where `SafeError = { code, message, retryable }`. Codes are fixed (`errors.ts`): extraction codes, TQ001–TQ003 mapped to `QUOTA_*`, `UPLOAD_INCOMPLETE`, `STORAGE_UNAVAILABLE`, etc. `processing_error` stores only the code. Logs carry ids and codes, never document text.
- Admin client use is limited to `svc_*` RPCs and Storage deletion, scoped to the verified user id, after the user-scoped read has proven ownership.

### Scheduled maintenance (`src/lib/server/maintenance/`, `GET /api/internal/maintenance`)

- **Schedule:** `vercel.json` runs the route once a day at `0 19 * * *` (19:00 UTC, 03:00 Philippine time). Hobby plans allow at most daily cron jobs, run some time within the scheduled hour, so don't rely on anything more frequent.
- **Authorization:** only `Authorization: Bearer <CRON_SECRET>`, checked in `cron-auth.ts`. Both sides are SHA-256-hashed, then compared with `timingSafeEqual`. A missing or <32-character secret rejects everything. Failures get a bare 401, and responses are `no-store`.
- **Setting the secret:**
  - **Vercel:** Project → Settings → Environment Variables, named `CRON_SECRET`, at least 32 random characters, set for Production (and Preview only if you want it there). Vercel Cron then sends the header automatically.
  - **Locally:** put it in `.env.local` and call the route with `curl` (see `.env.example`).
- **How it works** (`service.ts`, `server-only`, admin client):
  - Candidates come from `svc_maintenance_candidates` and `svc_find_orphan_objects` (database-side thresholds of 24 h, 15 min, 7 days and 1 h), never from a request.
  - Each candidate is re-read, scoped to its database owner id, and re-checked before anything is done.
  - Work is bounded: 50 rows per kind, 100 orphans, a 45 s budget, `maxDuration = 60`. Every step is idempotent, so the next run continues a partial one.
- **What each kind of record gets:**

  | Record | Action |
  |---|---|
  | `pending_upload` older than 24 h | deleted, along with its object |
  | `processing` older than 15 min | marked failed (`INTERNAL_ERROR`); its object is removed once it really is failed. A token attempt younger than 2 minutes (database clock) is refused and skipped |
  | `uploaded` | left for the teacher |
  | `deleting` / failed older than 7 days | the deletion is resumed |
  | Presentation being deleted | every object under `user/presentation/` is removed, then the row (which cascades) |
  | `generating` older than 15 min | fails the generation |
  | Superseded exports | deferred until PPTX export exists |
  | Orphan objects | deleted only if the path has our shape **and** a successful lookup finds no row |

  The run ends by pruning the quota ledger (7 days).
- Logs and the response carry counts and fixed codes only. Tests: `tests/cron-auth.test.ts` (unit) and `tests/maintenance.itest.ts` (hosted dev).
  - The client-side age checks compare this machine's clock with database timestamps; the dev machine measured ~0.3–0.5 s behind Supabase. The tests' "old enough now" thresholds are therefore −60 s, not 0.

### Upload quotas and drafts (migration `20261120000700_upload_quotas.sql`)

- `create_materials_draft(title, grade, subject, language, theme, slide_count, files jsonb)` is SECURITY INVOKER and callable by `authenticated` only. In one transaction it creates a materials presentation (title required) and 1–3 `pending_upload` documents, then returns `out_document_id` / `out_storage_path`.
- Per-user quotas are enforced by triggers on `source_documents`, under a per-user advisory lock, and require READ COMMITTED.
  - **Daily limits** (20 attempts, 200 MiB per UTC day; SQLSTATE `TQ001`/`TQ002`) are charged at registration, and charged again for the difference when verification finds a larger actual size. They are never refunded.
  - **Stored limit** (150 MiB; `TQ003`) is derived live from documents in `pending_upload`/`uploaded`/`processing`/`ready`, so failing or deleting a document releases it exactly once.
  - Limits live in `upload_quota_limits()`. `my_upload_quota()` returns the caller's usage. The `upload_quota_usage` ledger keeps 7 days, pruned per user on upload and globally by `svc_prune_upload_quota_usage`.
- Browser uploads: storage-js sends a `Blob`/`File` as multipart and **ignores `contentType`**; the stored MIME type is the Blob's own `type`, which is often empty for DOCX on Windows. Upload `file.slice(0, file.size, validatedMime)` instead. Storage only checks the declared type, so file contents must be validated on the server.

### shadcn/ui is built on Base UI, not Radix

`components.json` uses the `base-nova` style, so `src/components/ui/*` wraps `@base-ui/react`:

- No `asChild`. Compose with the `render` prop (e.g. `<SheetTrigger render={<Button … />}>`). For links styled as buttons, put `buttonVariants(...)` on `<Link className>` instead.
- Active/checked state attributes are `data-active`, `data-checked`, `data-open`, not Radix's `data-state`.
- `Select` needs `items` on the root so `SelectValue` shows labels, and its `onValueChange` can emit `null`.
- `cn` comes from the `cn` package (re-exported by `src/lib/utils.ts`), not clsx + tailwind-merge.
- Some generated components (e.g. Badge, which uses `useRender`) call hooks without `"use client"`. Don't use those from Server Components.
- Custom radio-style controls (`src/components/create/choice-group.tsx`, `theme-picker.tsx`) use `@base-ui/react/radio` primitives directly.

### Source layout

- `src/app/`: routes. `/` is the public landing page. `/login` and `/signup` are the auth pages, and `/auth/confirm` is the email callback. `/dashboard` (protected) has a layout with a fixed desktop sidebar and a mobile Sheet nav, plus a teacher card with sign-out. `/dashboard/create` is the creation form.
- `src/components/{marketing,dashboard,create,presentation,brand,auth}/`: feature components. `presentation/slide-preview.tsx` renders a theme's colors as a 16:9 thumbnail and is reused across the landing page, dashboard cards, theme picker and form summary.
- `src/lib/presentation-options.ts`: the single source for grades, subjects, languages, slide counts, themes (with hex colors meant to match future PPTX output) and `UPLOAD_RULES`. Add options here, not in components.
- `src/lib/mock-data.ts`: mock presentations; to be replaced by Supabase queries. The teacher's identity is already real and comes from the DAL. `/dashboard?view=empty` exists only to preview the empty state.

### Create-presentation form

`src/components/create/create-presentation-form.tsx` is the one stateful client component. Mode A and Mode B are Base UI Tabs panels holding the mode-specific inputs (topic/objectives vs. title + files). Class settings and theme are shared state outside the tabs, so they persist across mode switches. Validation runs on submit and focuses the first invalid field by id. `?mode=materials` selects the initial mode, and the form is keyed by mode so navigation resets it. Topic mode is still a placeholder (no AI yet).

**Materials upload** (`src/components/create/upload/`):
- `upload-state.ts`: pure reducer and mappings, unit-tested.
  - Per-file phases: waiting, uploading, upload_failed, processing, ready, failed, needs_retry.
  - Retries are offered only when the server marked the result retryable.
  - Nothing becomes `ready` unless the server says so.
  - Duplicate submits are ignored.
- `storage-upload.ts`: the browser uploads straight to Storage with `XMLHttpRequest`, for real progress events.
  - Same endpoint and headers as supabase-js, with the user's access token, `x-upsert: false`, and `file.slice(0, size, validatedMime)` as the body.
  - Bytes never go through a Server Action. A refused second write (`maybe_exists`) is handed to the server to decide.
- `use-materials-upload.ts`: draft action → parallel uploads → process action per file.
  - Bounded polling (3 s × 40) while anything is processing.
  - A `beforeunload` warning while busy.
- `upload-progress-panel.tsx` and `document-status-list.tsx`: the UI. One polite live summary, progress bars with ARIA values, and retry buttons that name their file.
- `/dashboard/presentations/[presentationId]`: the status page.
  - Loads server-side via `getPresentationDocumentsForCurrentUser`. Unknown, foreign, deleted or invalid ids all give `notFound()`.
  - `PresentationStatusView` polls, retries processing, and offers "Upload this file again" for `pending_upload` documents (refresh recovery). The status view exposes `upload { storagePath, contentType }` only for those documents.
  - Both pages set `maxDuration = 60`.
- `SidebarNav` wraps `usePathname()` in `<Suspense>`; required for pages with dynamic params under Cache Components.

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
