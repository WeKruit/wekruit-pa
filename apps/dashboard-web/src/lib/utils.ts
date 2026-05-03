// iter30/WS8 — shadcn/ui canonical `cn` helper. Merges Tailwind class
// arrays + de-duplicates conflicting utilities via tailwind-merge.
import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
