import { ChevronLeft, ChevronRight } from "lucide-react";
import type { PageInfo } from "../lib/api";
import { Button } from "./ui";

export function Pagination({ page, label, pending = false, onOffsetChange, onLimitChange }: {
  page: PageInfo; label: string; pending?: boolean;
  onOffsetChange: (offset: number) => void; onLimitChange?: (limit: number) => void;
}) {
  if (page.total === 0) return null;
  const current = Math.floor(page.offset / page.limit) + 1;
  const pages = Math.max(1, Math.ceil(page.total / page.limit));
  return <nav aria-label={`${label} pagination`} className="flex flex-wrap items-center justify-between gap-3 py-3">
    <p className="text-xs text-zinc-500" aria-live="polite">{page.offset + 1}–{Math.min(page.offset + page.limit, page.total)} of {page.total}</p>
    <div className="flex flex-wrap items-center gap-3">
      {onLimitChange && <label className="flex items-center gap-2 text-xs text-zinc-500">Per page<select aria-label={`${label} per page`} value={page.limit} disabled={pending} onChange={(event) => onLimitChange(Number(event.target.value))} className="h-8 rounded-md border border-line bg-ink px-2 text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal">{[10, 25, 50].map((size) => <option key={size} value={size}>{size}</option>)}</select></label>}
      <span className="text-xs text-zinc-500">Page {current} of {pages}</span>
      <div className="flex gap-1">
        <Button type="button" variant="secondary" size="sm" aria-label={`Previous ${label.toLowerCase()} page`} disabled={pending || page.offset === 0} onClick={() => onOffsetChange(Math.max(0, page.offset - page.limit))}><ChevronLeft className="h-4 w-4" /><span className="hidden sm:inline">Previous</span></Button>
        <Button type="button" variant="secondary" size="sm" aria-label={`Next ${label.toLowerCase()} page`} disabled={pending || page.offset + page.limit >= page.total} onClick={() => onOffsetChange(page.offset + page.limit)}><span className="hidden sm:inline">Next</span><ChevronRight className="h-4 w-4" /></Button>
      </div>
    </div>
  </nav>;
}
