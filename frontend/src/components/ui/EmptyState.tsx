export function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="border border-dashed border-line-strong px-6 py-10 text-center">
      <p className="text-sm text-ink">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-xs text-ink-muted">{detail}</p>
    </div>
  );
}
