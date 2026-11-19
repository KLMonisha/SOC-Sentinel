import { Link, useLocation } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { config } from "@/lib/config";
import { Chip } from "@/components/ui/Chip";

const SECTIONS: Record<string, string> = {
  "": "Command Center",
  evidence: "Evidence Room",
  counterfactual: "Counterfactual Lab",
  investigation: "Investigation Lab",
  "red-team": "Red Team Lab",
};

export function ContextBar({ visible }: { visible: boolean }) {
  const { pathname } = useLocation();
  const [, , section = "", id, sub] = pathname.split("/");
  const title = SECTIONS[section] ?? "Workspace";
  return (
    <header className="ctx-bar" data-bridge style={{ opacity: visible ? 1 : 0, transition: "opacity 0.7s ease" }}>
      <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center gap-2.5">
        <span className="t-label hidden sm:inline">Workspace</span>
        <ChevronRight size={12} aria-hidden className="hidden text-ink-faint sm:inline" />
        <Link to={`/app${section ? `/${section}` : ""}`} className={`t-micro truncate text-ink hover:text-verified ${id ? "hidden sm:inline" : ""}`}>{title}</Link>
        {id && (
          <>
            <ChevronRight size={12} aria-hidden className="hidden text-ink-faint sm:inline" />
            <span className={`truncate font-mono text-[12px] text-ink-muted ${sub ? "hidden sm:inline" : ""}`} title={decodeURIComponent(id)}>{decodeURIComponent(id)}</span>
          </>
        )}
        {sub === "report" && (
          <>
            <ChevronRight size={12} aria-hidden className="text-ink-faint" />
            <span className="t-micro text-ink">Report</span>
          </>
        )}
      </nav>
      <div className="flex shrink-0 items-center gap-2.5">
        {config.useMocks ? (
          <Chip dashed title="Responses are development fixtures served by the in-app mock, not backend data."><span className="hidden sm:inline">Mock&nbsp;</span>fixtures</Chip>
        ) : (
          <Chip tone="mint" dot title="Responses come from the FastAPI backend.">Live API</Chip>
        )}
        <Chip title="Containment is always a dry run. Approving records a decision; nothing is blocked or changed."><span className="hidden sm:inline">Containment:&nbsp;</span>dry-run</Chip>
      </div>
    </header>
  );
}
