// The two Economy tabs that read the run so far: they share one fetch of
// GET /economy (daily buckets), refreshed once per simulated day while open.

import type { EconomyReply } from '../engine/api';
import { ProcurementView } from './EconomyProcurement';
import { ProductionView } from './EconomyProduction';
import { useEconomy } from './economyData';

function Loaded({ open, children }: { open: boolean; children: (reply: EconomyReply) => React.ReactNode }) {
  const { data, error, loading } = useEconomy(open);
  if (data === null) {
    return (
      <p className="px-4 py-6 text-sm text-muted" data-testid="economy-empty">
        {error !== null ? `The figures could not be loaded: ${error}` : loading ? 'Adding up the run so far…' : 'Start the simulation to see the figures.'}
      </p>
    );
  }
  // while a refresh is in flight the last figures stay, dimmed: no flash, no jump
  return <div className={`transition-opacity ${loading ? 'opacity-60' : ''}`}>{children(data)}</div>;
}

export function EconomyProcurement({ open }: { open: boolean }) {
  return <Loaded open={open}>{(reply) => <ProcurementView reply={reply} />}</Loaded>;
}

export function EconomyProduction({ open }: { open: boolean }) {
  return <Loaded open={open}>{(reply) => <ProductionView reply={reply} />}</Loaded>;
}
