import { MOCK_TEACHER } from "@/lib/mock-data";

export function TeacherCard() {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-sidebar-border p-3">
      <span
        aria-hidden="true"
        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-linear-to-br from-brand-purple to-brand-blue text-sm font-semibold text-white"
      >
        {MOCK_TEACHER.firstName.charAt(0)}
      </span>
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold">Teacher {MOCK_TEACHER.firstName}</p>
        <p className="truncate text-xs text-muted-foreground">{MOCK_TEACHER.school}</p>
      </div>
    </div>
  );
}
