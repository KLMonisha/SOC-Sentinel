import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useParams } from "react-router-dom";
import { AppShell } from "./AppShell";
import { CommandCenter } from "@/pages/CommandCenter";
import { EvidenceRoom, EvidenceRoomIndex } from "@/pages/EvidenceRoom";
import { Placeholder } from "@/pages/Placeholder";

// The cinematic landing page (and its WebGL bundle) loads only when `/` is opened.
const Landing = lazy(() => import("@/features/landing/Landing"));

const LandingFallback = () => (
  <div role="status" aria-label="Loading" style={{ position: "fixed", inset: 0, background: "#030807" }} />
);

/** Deep links from before the landing page existed (`/evidence/case_x`) keep working under `/app`. */
function LegacyEvidenceRedirect() {
  const { caseId = "" } = useParams();
  return <Navigate to={`/app/evidence/${encodeURIComponent(caseId)}`} replace />;
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Suspense fallback={<LandingFallback />}><Landing /></Suspense>} />
      <Route path="app" element={<AppShell />}>
        <Route index element={<CommandCenter />} />
        <Route path="evidence" element={<EvidenceRoomIndex />} />
        <Route path="evidence/:caseId" element={<EvidenceRoom />} />
        <Route path="counterfactual" element={<Placeholder title="Counterfactual Investigation Lab" phase="Phase 7" />} />
        <Route path="investigate" element={<Placeholder title="Investigation Lab" phase="Phase 8" />} />
        <Route path="red-team" element={<Placeholder title="Red Team Lab" phase="Phase 9" />} />
      </Route>
      <Route path="evidence" element={<Navigate to="/app/evidence" replace />} />
      <Route path="evidence/:caseId" element={<LegacyEvidenceRedirect />} />
      <Route path="counterfactual" element={<Navigate to="/app/counterfactual" replace />} />
      <Route path="investigate" element={<Navigate to="/app/investigate" replace />} />
      <Route path="red-team" element={<Navigate to="/app/red-team" replace />} />
    </Routes>
  );
}
