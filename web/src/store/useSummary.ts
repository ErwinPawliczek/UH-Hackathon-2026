// The room's damage summary, polled while a screen that shows it is up.

import { useEffect, useState } from 'react';
import type { RoomSource } from './room';
import type { RoomSummary } from './roomTypes';

export function useSummary(source: RoomSource | null, everyMs = 2000): RoomSummary | null {
  const [summary, setSummary] = useState<RoomSummary | null>(null);
  useEffect(() => {
    if (source === null) return undefined;
    let stop = false;
    let busy = false;
    const load = () => {
      if (busy) return;
      busy = true;
      source.summary().then((s) => { if (!stop && s !== null) setSummary(s); }).catch(() => undefined).finally(() => { busy = false; });
    };
    load();
    const t = setInterval(load, everyMs);
    return () => { stop = true; clearInterval(t); };
  }, [source, everyMs]);
  return summary;
}
