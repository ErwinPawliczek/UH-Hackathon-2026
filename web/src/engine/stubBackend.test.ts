// Stub-backend outage tests: the §7.2 unit_outage command must actually take
// effect in stub mode (mirroring the hosted engine's event path) — trains
// drop, a fully-down unit idles its process, and the timeline gets an
// operator unit_failed entry.

import { describe, expect, it } from 'vitest';
import { StubBackend } from './stubBackend';

const SEED = 42;
const SITE_REFINERY = 1;

/** Flat unit index of RF-DHT: site-major [OIL-WELLS, CDU, VDU, NHT, CCR, BTX, FCC, FRAC, DHT]. */
const RF_DHT_IDX = 8;
/** Flat process index: OIL_PRODUCTION(0), then CD(1), REFORMING(2), FCC(3), DIESEL_HDT(4). */
const DHT_PROC_IDX = 4;

describe('StubBackend unit_outage', () => {
  it('drops trains online for the commanded unit and restores them after the window', async () => {
    const backend = new StubBackend();
    const { id } = await backend.create({ seed: SEED, scenario: 'none' });
    await backend.step(id, 100); // tick 100

    const res = (await backend.command(id, {
      type: 'unit_outage', site: SITE_REFINERY, unit: 'RF-DHT', trains: 1, duration_h: 24,
    })) as { ok: boolean };
    expect(res.ok).toBe(true);

    const during = await backend.step(id, 4); // tick 104 — inside the 96-tick window
    expect(during.unitTrains[RF_DHT_IDX]).toBe(1); // 2 design − 1 down
    expect(during.unitTrains[RF_DHT_IDX - 1]).toBe(1); // neighbours untouched

    // 24 h = 96 ticks; command at 100 → back online from tick 196
    const after = await backend.step(id, 200); // tick 304 — window over
    expect(after.unitTrains[RF_DHT_IDX]).toBe(2);
  });

  it('idles the process when every train is down', async () => {
    const backend = new StubBackend();
    const { id } = await backend.create({ seed: SEED, scenario: 'none' });
    await backend.step(id, 100);
    await backend.command(id, {
      type: 'unit_outage', site: SITE_REFINERY, unit: 'RF-DHT', trains: 2, duration_h: 24,
    });
    const during = await backend.step(id, 4);
    expect(during.unitTrains[RF_DHT_IDX]).toBe(0);
    expect(during.procStatus[DHT_PROC_IDX]).toBe(2); // Shutdown
    expect(during.procRate[DHT_PROC_IDX]).toBe(0);
  });

  it('emits an operator unit_failed event into the incremental log', async () => {
    const backend = new StubBackend();
    const { id } = await backend.create({ seed: SEED, scenario: 'none' });
    await backend.step(id, 100);
    await backend.command(id, {
      type: 'unit_outage', site: SITE_REFINERY, unit: 'RF-DHT', trains: 1, duration_h: 24,
    });
    await backend.step(id, 4);

    const events = await backend.events(id, 0);
    const operator = events.filter((e) => e.type === 'unit_failed' && e.text.startsWith('Operator:'));
    expect(operator).toHaveLength(1);
    expect(operator[0]).toMatchObject({ site: SITE_REFINERY, unit: 'RF-DHT', tick: 100 });

    // incremental polling after the event: no re-delivery, seqs stay monotonic
    const again = await backend.events(id, operator[0].seq);
    expect(again.some((e) => e.seq === operator[0].seq)).toBe(false);
    for (let i = 1; i < again.length; i++) expect(again[i].seq).toBeGreaterThan(again[i - 1].seq);
  });

  it('rejects malformed commands without queueing', async () => {
    const backend = new StubBackend();
    const { id } = await backend.create({ seed: SEED, scenario: 'none' });
    await backend.step(id, 100);
    const bad = (await backend.command(id, { type: 'unit_outage', site: 1, trains: 1 })) as { ok: boolean; error: string };
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('unit');
    const unknown = (await backend.command(id, {
      type: 'unit_outage', site: 1, unit: 'NO-SUCH-UNIT', trains: 1, duration_h: 24,
    })) as { ok: boolean; error: string };
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toContain('NO-SUCH-UNIT');
  });
});
