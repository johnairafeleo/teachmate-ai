"use client";

import { useState, type ReactNode } from "react";
import { Menu } from "lucide-react";

import { SidebarNav } from "@/components/dashboard/sidebar-nav";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

type MobileNavProps = {
  /** Server-rendered footer content (e.g. the teacher card). */
  footer?: ReactNode;
};

export function MobileNav({ footer }: MobileNavProps) {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger render={<Button variant="ghost" size="icon-lg" aria-label="Open navigation menu" />}>
        <Menu className="size-5" />
      </SheetTrigger>
      <SheetContent side="left" className="w-72 gap-0 bg-sidebar">
        <SheetHeader className="border-b border-sidebar-border">
          <SheetTitle className="font-heading text-lg font-semibold">TeachMate AI</SheetTitle>
          <SheetDescription>Navigate your workspace</SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto p-3">
          <SidebarNav onNavigate={() => setOpen(false)} />
        </div>
        {footer ? <div className="p-3">{footer}</div> : null}
      </SheetContent>
    </Sheet>
  );
}
