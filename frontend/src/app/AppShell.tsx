import { NavLink, Outlet } from "react-router-dom";
import { Radar, FolderSearch, GitCompareArrows, Crosshair, ShieldAlert } from "lucide-react";
import { config } from "@/lib/config";

const NAV = [
  { to: "/", label: "Command Center", Icon: Radar, end: true },
  { to: "/evidence", label: "Evidence Room", Icon: FolderSearch, end: false },
  { to: "/counterfactual", label: "Counterfactual Lab", Icon: GitCompareArrows, end: false },
  { to: "/investigate", label: "Investigation Lab", Icon: Crosshair, end: false },
  { to: "/red-team", label: "Red Team Lab", Icon: ShieldAlert, end: false },
];

export function AppShell() {
  return (
    <div className="grid h-full grid-cols-[220px_1fr] grid-rows-[48px_1fr]">
      <header className="col-span-2 flex items-center justify-between border-b border-line bg-surface px-4">
        <div className="flex items-baseline gap-3">
          <span className="text-sm font-semibold tracking-wide">SOC SENTINEL</span>
          <span className="hidden text-xs text-ink-faint sm:inline">What would change my mind?</span>
        </div>
        <div className="flex items-center gap-3 font-mono text-[11px]">
          {config.useMocks && (
            <span
              className="border border-suspicious/50 px-2 py-0.5 text-suspicious"
              title="Responses are development fixtures, not backend data"
            >
              MOCK DATA
            </span>
          )}
          <span className="border border-line-strong px-2 py-0.5 text-ink-muted">CONTAINMENT: DRY-RUN</span>
        </div>
      </header>
      <nav aria-label="Primary" className="border-r border-line bg-surface p-2">
        <ul className="space-y-0.5">
          {NAV.map(({ to, label, Icon, end }) => (
            <li key={to}>
              <NavLink
                to={to}
                end={end}
                className={({ isActive }) =>
                  `flex items-center gap-2.5 border-l-2 px-3 py-2 text-[13px] ${
                    isActive
                      ? "border-verified bg-surface-2 text-ink"
                      : "border-transparent text-ink-muted hover:bg-surface-2 hover:text-ink"
                  }`
                }
              >
                <Icon size={15} aria-hidden /> {label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <main className="overflow-auto p-6">
        <Outlet />
      </main>
    </div>
  );
}
