import { useEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { Crosshair, FolderSearch, GitCompareArrows, PanelLeftClose, PanelLeftOpen, Radar, ShieldAlert } from "lucide-react";

const NAV = [
  { to: "/app", label: "Command Center", Icon: Radar, end: true },
  { to: "/app/evidence", label: "Evidence Room", Icon: FolderSearch, end: false },
  { to: "/app/counterfactual", label: "Counterfactual Lab", Icon: GitCompareArrows, end: false },
  { to: "/app/investigation", label: "Investigation Lab", Icon: Crosshair, end: false },
  { to: "/app/red-team", label: "Red Team Lab", Icon: ShieldAlert, end: false },
] as const;

const Mark = () => (
  <svg viewBox="0 0 26 26" width="26" height="26" fill="none" aria-hidden>
    <path d="M3 17c4-9 9-12 13-9s0 10-5 11-6-5-2-9 9-3 12 3" stroke="#63ebd8" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);

/**
 * 72 px rail. Expands on hover and on keyboard focus; on touch devices (no hover) the toggle button
 * expands it, and it closes again after navigating, pressing Escape or tapping elsewhere.
 */
export function Rail({ visible }: { visible: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const { pathname } = useLocation();

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      if (ref.current?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    };
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("pointerdown", away); window.removeEventListener("keydown", esc); };
  }, [open]);

  return (
    <nav ref={ref} aria-label="Primary" className="rail" data-open={open} style={{ opacity: visible ? 1 : 0, transition: "opacity 0.7s ease" }}>
      <div className="rail-panel" data-bridge>
        <Link to="/" aria-label="SOC Sentinel overview (landing page)" title="Back to the overview"
          className="rail-item !h-[72px] hover:!bg-transparent">
          <span className="rail-icon"><Mark /></span>
          <span className="rail-label t-micro text-ink">SOC Sentinel</span>
        </Link>
        <div className="mx-5 my-1 hairline" />
        <ul className="mt-2 flex-1">
          {NAV.map(({ to, label, Icon, end }) => (
            <li key={to}>
              <NavLink to={to} end={end} className="rail-item" title={label}>
                <span className="rail-icon"><Icon size={19} strokeWidth={1.5} aria-hidden /></span>
                <span className="rail-label t-micro">{label}</span>
              </NavLink>
            </li>
          ))}
        </ul>
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={open ? "Collapse navigation" : "Expand navigation"}
          className="rail-item !h-14 w-full cursor-pointer border-0 bg-transparent text-left">
          <span className="rail-icon">{open ? <PanelLeftClose size={18} strokeWidth={1.5} aria-hidden /> : <PanelLeftOpen size={18} strokeWidth={1.5} aria-hidden />}</span>
          <span className="rail-label t-micro">{open ? "Collapse" : "Expand"}</span>
        </button>
      </div>
    </nav>
  );
}
