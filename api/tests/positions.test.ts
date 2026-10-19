/**
 * Tests for Issue #1425: Add event indexing for PositionPlaced events.
 *
 * Coverage:
 *  - PositionIndexer: writes a row per event, validates input, is idempotent
 *    on duplicate txHash, processes batches, rolls back reorgs.
 *  - InMemoryPositionSource: upsert semantics, rollback, list/count filtering.
 *  - GET /api/positions: returns indexed positions, respects query filters
 *    (market, account, outcome), paginator, rejects bad params.
 *
 * Acceptance criteria (issue #1425):
 *  ✓ Indexer writes a row per PositionPlaced (place_bet) event.
 *  ✓ Reorg / duplicate events are handled idempotently.
 *  ✓ API returns indexed positions.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

import { PositionIndexer } from '../src/services/position-indexer.js';
import {
  InMemoryPositionSource,
  createPositionsRouter,
} from '../src/routes/positions.js';
import type { PlaceBetEvent, IndexedPosition } from '../src/types/positions.js';
import { sharedRateLimiter } from '../src/middleware/rate-limit.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<PlaceBetEvent> = {}): PlaceBetEvent {
  return {
    market: 1,
    account: 'GABC1234ABCD5678EFGH9012IJKL3456MNOP7890QRST1234UVWX5678YZAB',
    outcome: 0,
    amount: '5000000',
    totalYes: '5000000',
    totalNo: '0',
    txHash: 'txhash_aaa111',
    ledgerSeq: 100,
    ...overrides,
  };
}

const ACCOUNT_A = 'GABC1234ABCD5678EFGH9012IJKL3456MNOP7890QRST1234UVWX5678YZAB';
const ACCOUNT_B = 'GBCD5678EFGH9012IJKL3456MNOP7890QRST1234UVWX5678YZABABC12345';

// ---------------------------------------------------------------------------
// PositionIndexer unit tests
// ---------------------------------------------------------------------------

describe('PositionIndexer (Issue #1425)', () => {
  let store: InMemoryPositionSource;
  let indexer: PositionIndexer;

  beforeEach(() => {
    store = new InMemoryPositionSource();
    indexer = new PositionIndexer(store);
  });

  // --- Acceptance criterion 1: writes a row per event ---

  it('writes one position row per unique (market, account, outcome) event', async () => {
    const event = makeEvent();
    const pos = await indexer.process(event);

    expect(pos.market).toBe(1);
    expect(pos.account).toBe(ACCOUNT_A);
    expect(pos.outcome).toBe(0);
    expect(pos.amount).toBe('5000000');
    expect(pos.totalYes).toBe('5000000');
    expect(pos.totalNo).toBe('0');
    expect(pos.lastTxHash).toBe('txhash_aaa111');
    expect(pos.lastLedgerSeq).toBe(100);
    expect(pos.createdAt).toBeTruthy();
    expect(pos.updatedAt).toBeTruthy();

    expect(store.all()).toHaveLength(1);
  });

  it('writes separate rows for different markets', async () => {
    await indexer.process(makeEvent({ market: 1, txHash: 'tx1' }));
    await indexer.process(makeEvent({ market: 2, txHash: 'tx2' }));
    expect(store.all()).toHaveLength(2);
  });

  it('writes separate rows for different accounts on the same market', async () => {
    await indexer.process(makeEvent({ account: ACCOUNT_A, txHash: 'tx1' }));
    await indexer.process(makeEvent({ account: ACCOUNT_B, txHash: 'tx2' }));
    expect(store.all()).toHaveLength(2);
  });

  it('writes separate rows for different outcomes on the same (market, account)', async () => {
    await indexer.process(makeEvent({ outcome: 0, txHash: 'tx1' }));
    await indexer.process(makeEvent({ outcome: 1, txHash: 'tx2' }));
    expect(store.all()).toHaveLength(2);
  });

  it('updates the existing row when the same slot receives a later event', async () => {
    await indexer.process(makeEvent({ amount: '1000', ledgerSeq: 10, txHash: 'tx1' }));
    await indexer.process(makeEvent({ amount: '2000', ledgerSeq: 11, txHash: 'tx2' }));
    const all = store.all();
    expect(all).toHaveLength(1);
    expect(all[0].amount).toBe('2000');
    expect(all[0].lastTxHash).toBe('tx2');
  });

  // --- Acceptance criterion 2: idempotency ---

  it('is idempotent: re-processing the same txHash leaves the row unchanged', async () => {
    const event = makeEvent({ amount: '1000', txHash: 'same_tx' });
    const first = await indexer.process(event);

    // Simulate re-delivery of the same event (e.g. from a restart)
    const second = await indexer.process(event);

    expect(second.amount).toBe(first.amount);
    expect(second.updatedAt).toBe(first.updatedAt);
    expect(store.all()).toHaveLength(1);
  });

  it('ignores an event from an older ledger than the stored one (stale replay)', async () => {
    await indexer.process(makeEvent({ amount: '2000', ledgerSeq: 50, txHash: 'tx_new' }));
    const result = await indexer.process(makeEvent({ amount: '999', ledgerSeq: 10, txHash: 'tx_old' }));
    // Row keeps the newer data
    expect(result.amount).toBe('2000');
    expect(result.lastLedgerSeq).toBe(50);
  });

  // --- Acceptance criterion 2: reorg handling ---

  it('rolls back positions written above the safe ledger after a reorg', async () => {
    await indexer.process(makeEvent({ ledgerSeq: 100, txHash: 'tx1', market: 1 }));
    await indexer.process(makeEvent({ ledgerSeq: 200, txHash: 'tx2', market: 2 }));
    await indexer.process(makeEvent({ ledgerSeq: 300, txHash: 'tx3', market: 3 }));

    const removed = await indexer.handleReorg(150);

    expect(removed).toBe(2); // ledger 200 and 300 removed
    expect(store.all()).toHaveLength(1);
    expect(store.all()[0].lastLedgerSeq).toBe(100);
  });

  it('returns 0 removed positions when there is nothing above the safe ledger', async () => {
    await indexer.process(makeEvent({ ledgerSeq: 50, txHash: 'tx1' }));
    const removed = await indexer.handleReorg(100);
    expect(removed).toBe(0);
    expect(store.all()).toHaveLength(1);
  });

  // --- Validation ---

  it('throws TypeError for a missing market field', async () => {
    const bad = { ...makeEvent(), market: -1 };
    await expect(indexer.process(bad)).rejects.toThrow('market must be a non-negative integer');
  });

  it('throws TypeError for an empty account', async () => {
    const bad = { ...makeEvent(), account: '' };
    await expect(indexer.process(bad)).rejects.toThrow('account must be a non-empty string');
  });

  it('throws TypeError for a non-integer-string amount', async () => {
    const bad = { ...makeEvent(), amount: 'not_a_number' };
    await expect(indexer.process(bad)).rejects.toThrow('amount must be a valid integer string');
  });

  it('throws TypeError for a negative ledgerSeq', async () => {
    const bad = { ...makeEvent(), ledgerSeq: -1 };
    await expect(indexer.process(bad)).rejects.toThrow('ledgerSeq must be a non-negative integer');
  });

  // --- Batch processing ---

  it('processes a batch of events in order', async () => {
    const events = [
      makeEvent({ market: 1, txHash: 'tx1', ledgerSeq: 1 }),
      makeEvent({ market: 2, txHash: 'tx2', ledgerSeq: 2 }),
      makeEvent({ market: 3, txHash: 'tx3', ledgerSeq: 3 }),
    ];
    const results = await indexer.processBatch(events);
    expect(results).toHaveLength(3);
    expect(store.all()).toHaveLength(3);
  });

  it('collects all errors from a batch and re-throws them together', async () => {
    const events = [
      makeEvent({ txHash: 'good_tx', market: 1 }),
      { ...makeEvent(), market: -1 } as PlaceBetEvent,  // invalid
      { ...makeEvent(), account: '' }  as PlaceBetEvent, // invalid
    ];
    await expect(indexer.processBatch(events)).rejects.toThrow('2 event(s) failed to process');
    // The valid event was still written
    expect(store.all()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// InMemoryPositionSource unit tests
// ---------------------------------------------------------------------------

describe('InMemoryPositionSource (Issue #1425)', () => {
  let source: InMemoryPositionSource;

  beforeEach(() => {
    source = new InMemoryPositionSource();
  });

  it('starts empty', async () => {
    expect(await source.count()).toBe(0);
    expect(await source.list(0, 10)).toEqual([]);
  });

  it('count() and list() respect market filter', async () => {
    await source.upsert(makeEvent({ market: 1, txHash: 'tx1' }));
    await source.upsert(makeEvent({ market: 2, txHash: 'tx2' }));

    expect(await source.count({ market: 1 })).toBe(1);
    expect(await source.list(0, 10, { market: 1 })).toHaveLength(1);
  });

  it('count() and list() respect account filter', async () => {
    await source.upsert(makeEvent({ account: ACCOUNT_A, txHash: 'tx1' }));
    await source.upsert(makeEvent({ account: ACCOUNT_B, txHash: 'tx2' }));

    expect(await source.count({ account: ACCOUNT_A })).toBe(1);
    const rows = await source.list(0, 10, { account: ACCOUNT_A });
    expect(rows).toHaveLength(1);
    expect(rows[0].account).toBe(ACCOUNT_A);
  });

  it('count() and list() respect outcome filter', async () => {
    await source.upsert(makeEvent({ outcome: 0, txHash: 'tx1' }));
    await source.upsert(makeEvent({ outcome: 1, txHash: 'tx2' }));

    expect(await source.count({ outcome: 0 })).toBe(1);
    const rows = await source.list(0, 10, { outcome: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe(1);
  });

  it('list() returns results in stable (market, account, outcome) order', async () => {
    await source.upsert(makeEvent({ market: 2, txHash: 'tx1' }));
    await source.upsert(makeEvent({ market: 1, txHash: 'tx2' }));
    await source.upsert(makeEvent({ market: 3, txHash: 'tx3' }));

    const rows = await source.list(0, 10);
    expect(rows.map((r) => r.market)).toEqual([1, 2, 3]);
  });

  it('upsert() returns a clone; mutations on the returned object do not affect the store', async () => {
    const pos = await source.upsert(makeEvent());
    pos.amount = '999';

    const stored = (await source.list(0, 1))[0];
    expect(stored.amount).toBe('5000000'); // original value
  });

  it('rollback() removes rows above the given ledger and returns count', async () => {
    await source.upsert(makeEvent({ ledgerSeq: 10, txHash: 'tx1', market: 1 }));
    await source.upsert(makeEvent({ ledgerSeq: 20, txHash: 'tx2', market: 2 }));
    await source.upsert(makeEvent({ ledgerSeq: 30, txHash: 'tx3', market: 3 }));

    const n = await source.rollback(15);
    expect(n).toBe(2);
    expect(await source.count()).toBe(1);
  });

  it('clear() removes all positions', async () => {
    await source.upsert(makeEvent({ txHash: 'tx1' }));
    source.clear();
    expect(await source.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GET /api/positions HTTP tests
// ---------------------------------------------------------------------------

describe('GET /api/positions (Issue #1425)', () => {
  let app: express.Express;
  let source: InMemoryPositionSource;

  beforeEach(async () => {
    sharedRateLimiter.reset();
    source = new InMemoryPositionSource();

    // Seed 3 positions across 2 markets and 2 accounts
    const indexer = new PositionIndexer(source);
    await indexer.process(makeEvent({ market: 1, account: ACCOUNT_A, outcome: 0, txHash: 'tx1', ledgerSeq: 10, amount: '1000' }));
    await indexer.process(makeEvent({ market: 1, account: ACCOUNT_A, outcome: 1, txHash: 'tx2', ledgerSeq: 11, amount: '2000' }));
    await indexer.process(makeEvent({ market: 2, account: ACCOUNT_B, outcome: 0, txHash: 'tx3', ledgerSeq: 12, amount: '3000' }));

    app = express();
    app.use('/api/positions', createPositionsRouter(source));
  });

  // --- Acceptance criterion 3: API returns indexed positions ---

  it('returns all indexed positions with success envelope', async () => {
    const res = await request(app).get('/api/positions');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(3);
    expect(res.body.pagination).toMatchObject({
      total: 3,
      limit: 20,
      offset: 0,
      count: 3,
      hasMore: false,
      nextOffset: null,
    });
    expect(res.body.timestamp).toBeTruthy();
  });

  it('returns positions in stable (market, account, outcome) order', async () => {
    const res = await request(app).get('/api/positions');

    const markets = res.body.data.map((p: IndexedPosition) => p.market);
    expect(markets).toEqual([1, 1, 2]);
  });

  // --- Filter: market ---

  it('filters by market', async () => {
    const res = await request(app).get('/api/positions?market=1');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.every((p: IndexedPosition) => p.market === 1)).toBe(true);
    expect(res.body.pagination.total).toBe(2);
  });

  it('returns empty data for an unknown market', async () => {
    const res = await request(app).get('/api/positions?market=999');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.pagination.total).toBe(0);
  });

  // --- Filter: account ---

  it('filters by account', async () => {
    const res = await request(app).get(`/api/positions?account=${ACCOUNT_B}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].account).toBe(ACCOUNT_B);
  });

  // --- Filter: outcome ---

  it('filters by outcome', async () => {
    const res = await request(app).get('/api/positions?outcome=1');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].outcome).toBe(1);
  });

  // --- Combined filters ---

  it('combines market + account filters', async () => {
    const res = await request(app).get(`/api/positions?market=1&account=${ACCOUNT_A}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.every((p: IndexedPosition) => p.market === 1 && p.account === ACCOUNT_A)).toBe(true);
  });

  // --- Pagination ---

  it('paginates correctly with limit and offset', async () => {
    const page1 = await request(app).get('/api/positions?limit=2&offset=0');
    const page2 = await request(app).get('/api/positions?limit=2&offset=2');

    expect(page1.status).toBe(200);
    expect(page1.body.data).toHaveLength(2);
    expect(page1.body.pagination).toMatchObject({ total: 3, hasMore: true, nextOffset: 2 });

    expect(page2.status).toBe(200);
    expect(page2.body.data).toHaveLength(1);
    expect(page2.body.pagination).toMatchObject({ total: 3, hasMore: false, nextOffset: null });
  });

  it('returns empty data for an out-of-range offset', async () => {
    const res = await request(app).get('/api/positions?offset=500');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  // --- Validation errors ---

  it.each([
    ['limit=0'],
    ['limit=-5'],
    ['limit=abc'],
    ['offset=-1'],
    ['offset=xyz'],
  ])('returns 400 for invalid pagination params (%s)', async (qs) => {
    const res = await request(app).get(`/api/positions?${qs}`);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for a non-integer market param', async () => {
    const res = await request(app).get('/api/positions?market=abc');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for a non-integer outcome param', async () => {
    const res = await request(app).get('/api/positions?outcome=abc');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for an empty account param', async () => {
    const res = await request(app).get('/api/positions?account=   ');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  // --- Idempotency visible through the API ---

  it('API returns the same count when the same event is replayed', async () => {
    const indexer = new PositionIndexer(source);
    // Re-process tx1 – the count must not increase
    await indexer.process(makeEvent({ market: 1, account: ACCOUNT_A, outcome: 0, txHash: 'tx1', ledgerSeq: 10, amount: '1000' }));

    const res = await request(app).get('/api/positions');
    expect(res.body.pagination.total).toBe(3); // still 3, not 4
  });

  // --- Empty store ---

  it('returns an empty list when no events have been indexed', async () => {
    source.clear();
    const res = await request(app).get('/api/positions');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.pagination.total).toBe(0);
  });

  // --- Response shape ---

  it('each position row has the expected fields', async () => {
    const res = await request(app).get('/api/positions?market=1&limit=1');
    const pos: IndexedPosition = res.body.data[0];

    expect(typeof pos.market).toBe('number');
    expect(typeof pos.account).toBe('string');
    expect(typeof pos.outcome).toBe('number');
    expect(typeof pos.amount).toBe('string');
    expect(typeof pos.totalYes).toBe('string');
    expect(typeof pos.totalNo).toBe('string');
    expect(typeof pos.lastTxHash).toBe('string');
    expect(typeof pos.lastLedgerSeq).toBe('number');
    expect(typeof pos.createdAt).toBe('string');
    expect(typeof pos.updatedAt).toBe('string');
  });
});

// ===========================================================================
// #1445 — page/pageSize pagination tests
// ===========================================================================

import {
  parsePagePagination,
  MAX_PAGE_LIMIT,
  DEFAULT_PAGE_LIMIT,
} from '../src/services/pagination.js';

describe('parsePagePagination helper (Issue #1445)', () => {
  it('returns default page=1 and pageSize=20 when no params given', () => {
    const result = parsePagePagination({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.params.page).toBe(1);
    expect(result.params.pageSize).toBe(DEFAULT_PAGE_LIMIT);
    expect(result.params.limit).toBe(DEFAULT_PAGE_LIMIT);
    expect(result.params.offset).toBe(0);
  });

  it('translates page=2, pageSize=10 correctly to offset=10, limit=10', () => {
    const result = parsePagePagination({ page: '2', pageSize: '10' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.params.page).toBe(2);
    expect(result.params.pageSize).toBe(10);
    expect(result.params.offset).toBe(10);
    expect(result.params.limit).toBe(10);
  });

  it('translates page=3, pageSize=25 correctly to offset=50, limit=25', () => {
    const result = parsePagePagination({ page: '3', pageSize: '25' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.params.offset).toBe(50);
    expect(result.params.limit).toBe(25);
  });

  it('clamps an oversized pageSize to MAX_PAGE_LIMIT instead of rejecting it', () => {
    const result = parsePagePagination({ pageSize: '9999' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.params.pageSize).toBe(MAX_PAGE_LIMIT);
    expect(result.params.limit).toBe(MAX_PAGE_LIMIT);
  });

  it('clamps pageSize=MAX_PAGE_LIMIT exactly (boundary — no clamping needed)', () => {
    const result = parsePagePagination({ pageSize: String(MAX_PAGE_LIMIT) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.params.pageSize).toBe(MAX_PAGE_LIMIT);
  });

  it('rejects pageSize=0', () => {
    const result = parsePagePagination({ pageSize: '0' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatch(/pageSize/);
  });

  it('rejects pageSize=-1', () => {
    const result = parsePagePagination({ pageSize: '-1' });
    expect(result.ok).toBe(false);
  });

  it('rejects pageSize=abc', () => {
    const result = parsePagePagination({ pageSize: 'abc' });
    expect(result.ok).toBe(false);
  });

  it('rejects page=0', () => {
    const result = parsePagePagination({ page: '0' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatch(/page/);
  });

  it('rejects page=-1', () => {
    const result = parsePagePagination({ page: '-1' });
    expect(result.ok).toBe(false);
  });

  it('rejects page=abc', () => {
    const result = parsePagePagination({ page: 'abc' });
    expect(result.ok).toBe(false);
  });

  it('reports all errors at once when both page and pageSize are invalid', () => {
    const result = parsePagePagination({ page: '0', pageSize: '0' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(2);
  });
});

describe('GET /api/positions — page/pageSize style (Issue #1445)', () => {
  let app: express.Express;
  let source: InMemoryPositionSource;

  // Seed 12 distinct positions so we have something to page through
  beforeEach(async () => {
    sharedRateLimiter.reset();
    source = new InMemoryPositionSource();
    const indexer = new PositionIndexer(source);

    // 12 positions: markets 1–6, each with outcomes 0 and 1
    for (let m = 1; m <= 6; m++) {
      for (let o = 0; o <= 1; o++) {
        await indexer.process(
          makeEvent({
            market: m,
            outcome: o,
            txHash: `tx_m${m}_o${o}`,
            ledgerSeq: m * 10 + o,
            amount: String(m * 1000 + o * 100),
          })
        );
      }
    }

    app = express();
    app.use('/api/positions', createPositionsRouter(source));
  });

  // ── Acceptance criterion: endpoint supports paged responses and reports total ──

  it('returns page 1 with default pageSize and reports total', async () => {
    const res = await request(app).get('/api/positions?page=1');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(12); // all 12 fit in default pageSize=20
    expect(res.body.pagination).toMatchObject({
      total: 12,
      page: 1,
      pageSize: DEFAULT_PAGE_LIMIT,
    });
  });

  it('returns correct data on page 1 with pageSize=5', async () => {
    const res = await request(app).get('/api/positions?page=1&pageSize=5');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(5);
    expect(res.body.pagination).toMatchObject({
      total: 12,
      page: 1,
      pageSize: 5,
      hasMore: true,
    });
  });

  it('returns correct data on page 2 with pageSize=5', async () => {
    const res = await request(app).get('/api/positions?page=2&pageSize=5');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(5);
    expect(res.body.pagination).toMatchObject({
      total: 12,
      page: 2,
      pageSize: 5,
      hasMore: true,
      offset: 5,
    });
  });

  it('returns the partial last page correctly', async () => {
    // page=3 with pageSize=5 → offset=10, 2 items remain
    const res = await request(app).get('/api/positions?page=3&pageSize=5');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.pagination).toMatchObject({
      total: 12,
      page: 3,
      pageSize: 5,
      count: 2,
      hasMore: false,
      nextOffset: null,
    });
  });

  it('returns an empty data array for an out-of-range page', async () => {
    const res = await request(app).get('/api/positions?page=999&pageSize=10');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.pagination).toMatchObject({
      total: 12,
      count: 0,
      hasMore: false,
    });
  });

  // ── Acceptance criterion: oversized pageSize is clamped ──

  it('clamps an oversized pageSize and still returns data', async () => {
    const res = await request(app).get('/api/positions?pageSize=99999');

    expect(res.status).toBe(200);
    expect(res.body.pagination.pageSize).toBe(MAX_PAGE_LIMIT);
    expect(res.body.pagination.limit).toBe(MAX_PAGE_LIMIT);
    // All 12 items fit within the capped page
    expect(res.body.data).toHaveLength(12);
  });

  it('pagination block always includes page and pageSize fields', async () => {
    const res = await request(app).get('/api/positions?page=1&pageSize=3');
    const p = res.body.pagination;

    expect(typeof p.page).toBe('number');
    expect(typeof p.pageSize).toBe('number');
    expect(typeof p.total).toBe('number');
  });

  // ── Validation errors ──

  it('returns 400 for page=0', async () => {
    const res = await request(app).get('/api/positions?page=0');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for page=abc', async () => {
    const res = await request(app).get('/api/positions?page=abc');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for pageSize=0', async () => {
    const res = await request(app).get('/api/positions?pageSize=0');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for pageSize=abc', async () => {
    const res = await request(app).get('/api/positions?pageSize=abc');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  // ── Backward-compatibility: limit/offset still works ──

  it('still supports limit/offset when page/pageSize are absent', async () => {
    const res = await request(app).get('/api/positions?limit=4&offset=0');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(4);
    expect(res.body.pagination).toMatchObject({
      total: 12,
      limit: 4,
      offset: 0,
      hasMore: true,
    });
    // page/pageSize are still emitted (back-computed)
    expect(typeof res.body.pagination.page).toBe('number');
    expect(typeof res.body.pagination.pageSize).toBe('number');
  });

  it('page/pageSize takes precedence when both styles are present', async () => {
    // limit=2 would give 2 items; page=1&pageSize=7 should give 7 items
    const res = await request(app).get('/api/positions?limit=2&offset=0&page=1&pageSize=7');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(7);
    expect(res.body.pagination.pageSize).toBe(7);
  });

  // ── total is always reported correctly ──

  it('reports the correct total regardless of page size', async () => {
    const [r1, r2, r3] = await Promise.all([
      request(app).get('/api/positions?pageSize=1'),
      request(app).get('/api/positions?pageSize=6'),
      request(app).get('/api/positions?pageSize=20'),
    ]);
    expect(r1.body.pagination.total).toBe(12);
    expect(r2.body.pagination.total).toBe(12);
    expect(r3.body.pagination.total).toBe(12);
  });

  it('total reflects filters combined with page/pageSize', async () => {
    // market=1 has 2 positions (outcomes 0 and 1)
    const res = await request(app).get('/api/positions?market=1&page=1&pageSize=10');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.pagination.total).toBe(2);
  });
});
