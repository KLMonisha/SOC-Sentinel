import { Route, Routes } from "react-router-dom";
import { AppShell } from "./AppShell";
import { CommandCenter } from "@/pages/CommandCenter";
import { Placeholder } from "@/pages/Placeholder";

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<CommandCenter />} />
        <Route path="evidence" element={<Placeholder title="Evidence Room" phase="Phase 5" />} />
        <Route path="evidence/:caseId" element={<Placeholder title="Evidence Room" phase="Phase 5" />} />
        <Route path="counterfactual" element={<Placeholder title="Counterfactual Investigation Lab" phase="Phase 7" />} />
        <Route path="investigate" element={<Placeholder title="Investigation Lab" phase="Phase 8" />} />
        <Route path="red-team" element={<Placeholder title="Red Team Lab" phase="Phase 9" />} />
      </Route>
    </Routes>
  );
}
