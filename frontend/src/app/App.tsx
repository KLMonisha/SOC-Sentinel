import { Navigate, Route, Routes, useParams } from "react-router-dom";
import { AppShell } from "./AppShell";
import { LandingHost } from "./transition/LandingHost";
import { TransitionProvider } from "./transition/TransitionProvider";
import { CommandCenter } from "@/pages/CommandCenter";
import { EvidenceRoom, EvidenceRoomIndex } from "@/pages/EvidenceRoom";
import { CounterfactualIndex } from "@/pages/CounterfactualIndex";
import { CounterfactualLab } from "@/pages/CounterfactualLab";
import { InvestigationIndex } from "@/pages/InvestigationIndex";
import { InvestigationLab } from "@/pages/InvestigationLab";
import { RedTeamLab } from "@/pages/RedTeamLab";
import { ReportPage } from "@/pages/ReportPage";

/** Deep links from before the landing page existed (`/evidence/case_x`) keep working under `/app`. */
function LegacyEvidenceRedirect() {
  const { caseId = "" } = useParams();
  return <Navigate to={`/app/evidence/${encodeURIComponent(caseId)}`} replace />;
}

function LegacyInvestigationRedirect() {
  const { caseId = "" } = useParams();
  return <Navigate to={`/app/investigation/${encodeURIComponent(caseId)}`} replace />;
}

export function App() {
  return (
    <TransitionProvider>
      {/* The landing is not a route element: it is hosted so it can stay mounted while the app takes over. */}
      <LandingHost />
      <Routes>
        <Route path="/" element={null} />
        <Route path="app" element={<AppShell />}>
          <Route index element={<CommandCenter />} />
          <Route path="evidence" element={<EvidenceRoomIndex />} />
          <Route path="evidence/:caseId" element={<EvidenceRoom />} />
          <Route path="evidence/:caseId/report" element={<ReportPage />} />
          <Route path="counterfactual" element={<CounterfactualIndex />} />
          <Route path="counterfactual/:caseId" element={<CounterfactualLab />} />
          <Route path="investigation" element={<InvestigationIndex />} />
          <Route path="investigation/:caseId" element={<InvestigationLab />} />
          <Route path="investigate" element={<Navigate to="/app/investigation" replace />} />
          <Route path="investigate/:caseId" element={<LegacyInvestigationRedirect />} />
          <Route path="red-team" element={<RedTeamLab />} />
        </Route>
        <Route path="evidence" element={<Navigate to="/app/evidence" replace />} />
        <Route path="evidence/:caseId" element={<LegacyEvidenceRedirect />} />
        <Route path="counterfactual" element={<Navigate to="/app/counterfactual" replace />} />
        <Route path="investigate" element={<Navigate to="/app/investigation" replace />} />
        <Route path="red-team" element={<Navigate to="/app/red-team" replace />} />
      </Routes>
    </TransitionProvider>
  );
}
