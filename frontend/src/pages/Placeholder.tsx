import { Panel } from "@/components/ui/Panel";
import { EmptyState } from "@/components/ui/EmptyState";

export function Placeholder({ title, phase }: { title: string; phase: string }) {
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <h1 className="text-lg font-semibold">{title}</h1>
      <Panel title="Status" meta={phase}>
        <EmptyState
          title="Not implemented yet"
          detail={`Scheduled for ${phase}. No data is shown until it is wired to the backend contract.`}
        />
      </Panel>
    </div>
  );
}
