import { Route, Routes } from "react-router-dom";
import { AppShell } from "./AppShell";
import { CommandCenter } from "@/pages/CommandCenter";
import { EvidenceRoom, EvidenceRoomIndex } from "@/pages/EvidenceRoom";
import { Placeholder } from "@/pages/Placeholder";

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<CommandCenter />} />
        <Route path="evidence" element={<EvidenceRoomIndex />} />
        <Route path="evidence/:caseId" element={<EvidenceRoom />} />
        <Route path="counterfactual" element={<Placeholder title="Counterfactual Investigation Lab" phase="Phase 7" />} />
        <Route path="investigate" element={<Placeholder title="Investigation Lab" phase="Phase 8" />} />
        <Route path="red-team" element={<Placeholder title="Red Team Lab" phase="Phase 9" />} />
      </Route>
    </Routes>
  );
}
