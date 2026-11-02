"use client";

import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";

export function PrintButton({ label = "Imprimer", title }: { label?: string; title?: string }) {
  return (
    <Button variant="secondary" onClick={() => window.print()} title={title} className="print:hidden">
      <Printer aria-hidden className="size-4" />
      {label}
    </Button>
  );
}
