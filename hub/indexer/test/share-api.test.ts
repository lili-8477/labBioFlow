import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { Pool } from 'pg';
import { shareRoutesPlugin, type ShareApiDeps } from '../src/share-api.js';
import type { ShareRequest } from '../src/share-repo.js';

// Canned ShareRequest returned by getShareRequest happy-path tests.
const cannedRequest: ShareRequest = {
  share_id:         'sr-abc-123',
  artifact_kind:    'memory',
  artifact_ref:     'mem-ref-1',
  snapshot_meta:    { name: 'Snap', description: 'd', body: 'b', type: 'user', source: 'user', hit_count: 0, last_hit_at: null, facets: {} },
  requester:        'alice',
  reviewer:         'li86',
  status:           'pending',
  requester_note:   null,
  review_comment:   null,
  promotion_result: null,
  created_at:       '2026-01-01T00:00:00.000Z',
  decided_at:       null,
};

// Test-double factory: each repo function is a vi.fn() with a sensible default.
// Tests override per-case with mockResolvedValueOnce.
function makeDeps(): { deps: ShareApiDeps; repo: Record<string, ReturnType<typeof vi.fn>> } {
  const repo = {
    submitShareRequest:   vi.fn(async () => ({ ok: true, share_id: 'sid-1' })),
    listShareRequests:    vi.fn(async () => ({ items: [], next_cursor: null })),
    getShareRequest:      vi.fn(async () => ({ ...cannedRequest })),
    decideShareRequest:   vi.fn(async () => ({ ok: true, status: 'approved' })),
    withdrawShareRequest: vi.fn(async () => ({ ok: true })),
    getShareCapabilities: vi.fn(async () => ({
      is_manager:          true,
      manager_username:    'li86',
      pending_inbox_count: 3,
      actor_username:      'li86',
    })),
  };
  const deps: ShareApiDeps = { pool: {} as Pool, manager: 'li86', workspacesRoot: '/tmp/unused', shareSnapshotsDir: '/tmp/unused', repo: repo as ShareApiDeps['repo'] };
  return { deps, repo };
}

describe('share-api plugin', () => {
  let app: ReturnType<typeof Fastify>;
  let depsBag: ReturnType<typeof makeDeps>;

  beforeEach(async () => {
    if (app) await app.close();
    depsBag = makeDeps();
    app = Fastify({ logger: false });
    await app.register(shareRoutesPlugin(depsBag.deps));
  });

  // ─── POST /share/submit ────────────────────────────────────────────────────

  describe('POST /share/submit', () => {
    const validBody = { requester: 'alice', kind: 'memory', ref: 'mem-ref-1' };

    it('happy path: calls submitShareRequest and returns share_id', async () => {
      depsBag.repo.submitShareRequest.mockResolvedValueOnce({ ok: true, share_id: 'sid-99' });
      const res = await app.inject({ method: 'POST', url: '/share/submit', payload: validBody });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ share_id: 'sid-99' });
      expect(depsBag.repo.submitShareRequest).toHaveBeenCalledTimes(1);
      const arg = depsBag.repo.submitShareRequest.mock.calls[0]![0];
      expect(arg.pool).toBe(depsBag.deps.pool);
      expect(arg.manager).toBe('li86');
      expect(arg.requester).toBe('alice');
      expect(arg.kind).toBe('memory');
      expect(arg.ref).toBe('mem-ref-1');
    });

    it('503 when deps.manager is null (sharing disabled)', async () => {
      depsBag.deps.manager = null;
      const res = await app.inject({ method: 'POST', url: '/share/submit', payload: validBody });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ error: expect.stringContaining('sharing disabled') });
      expect(depsBag.repo.submitShareRequest).not.toHaveBeenCalled();
    });

    it('400 when required field (requester) is missing', async () => {
      const res = await app.inject({ method: 'POST', url: '/share/submit', payload: { kind: 'memory', ref: 'r' } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'validation failed', issues: expect.any(Array) });
      expect(depsBag.repo.submitShareRequest).not.toHaveBeenCalled();
    });

    it('400 when kind is invalid', async () => {
      const res = await app.inject({ method: 'POST', url: '/share/submit', payload: { requester: 'alice', kind: 'image', ref: 'r' } });
      expect(res.statusCode).toBe(400);
      expect(depsBag.repo.submitShareRequest).not.toHaveBeenCalled();
    });

    it('501 when repo returns not_implemented (kind=skill)', async () => {
      depsBag.repo.submitShareRequest.mockResolvedValueOnce({ ok: false, reason: 'not_implemented' });
      const res = await app.inject({ method: 'POST', url: '/share/submit', payload: { requester: 'alice', kind: 'skill', ref: 'r' } });
      expect(res.statusCode).toBe(501);
      expect(res.json()).toMatchObject({ error: expect.stringContaining('skill') });
    });

    it('403 when repo returns forbidden', async () => {
      depsBag.repo.submitShareRequest.mockResolvedValueOnce({ ok: false, reason: 'forbidden' });
      const res = await app.inject({ method: 'POST', url: '/share/submit', payload: validBody });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: 'source not found or not owned by requester' });
    });
  });

  // ─── GET /share/list ───────────────────────────────────────────────────────

  describe('GET /share/list', () => {
    it('happy path: forwards query params and returns items', async () => {
      depsBag.repo.listShareRequests.mockResolvedValueOnce({ items: [cannedRequest], next_cursor: null });
      const res = await app.inject({ method: 'GET', url: '/share/list?actor=alice&role=outbox' });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.items).toHaveLength(1);
      expect(json.items[0].share_id).toBe('sr-abc-123');
      expect(json.next_cursor).toBeNull();
      const arg = depsBag.repo.listShareRequests.mock.calls[0]![0];
      expect(arg.pool).toBe(depsBag.deps.pool);
      expect(arg.actor).toBe('alice');
      expect(arg.manager).toBe('li86');
      expect(arg.role).toBe('outbox');
    });

    it('forwards optional status + limit + cursor', async () => {
      const res = await app.inject({
        method: 'GET',
        url:    '/share/list?actor=alice&role=inbox&status=pending&limit=10&cursor=2026-01-01T00:00:00.000Z|some-uuid',
      });
      expect(res.statusCode).toBe(200);
      const arg = depsBag.repo.listShareRequests.mock.calls[0]![0];
      expect(arg.status).toBe('pending');
      expect(arg.limit).toBe(10);
      expect(arg.cursor).toBe('2026-01-01T00:00:00.000Z|some-uuid');
    });

    it('400 when actor is missing', async () => {
      const res = await app.inject({ method: 'GET', url: '/share/list?role=outbox' });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'validation failed', issues: expect.any(Array) });
      expect(depsBag.repo.listShareRequests).not.toHaveBeenCalled();
    });

    it('400 when role is invalid', async () => {
      const res = await app.inject({ method: 'GET', url: '/share/list?actor=alice&role=wrong' });
      expect(res.statusCode).toBe(400);
      expect(depsBag.repo.listShareRequests).not.toHaveBeenCalled();
    });
  });

  // ─── GET /share/capabilities ───────────────────────────────────────────────

  describe('GET /share/capabilities', () => {
    it('happy path: returns capabilities verbatim', async () => {
      const res = await app.inject({ method: 'GET', url: '/share/capabilities?actor=li86' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        is_manager:          true,
        manager_username:    'li86',
        pending_inbox_count: 3,
        actor_username:      'li86',
      });
      const arg = depsBag.repo.getShareCapabilities.mock.calls[0]![0];
      expect(arg.pool).toBe(depsBag.deps.pool);
      expect(arg.actor).toBe('li86');
      expect(arg.manager).toBe('li86');
    });

    it('400 when actor is missing', async () => {
      const res = await app.inject({ method: 'GET', url: '/share/capabilities' });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'validation failed', issues: expect.any(Array) });
      expect(depsBag.repo.getShareCapabilities).not.toHaveBeenCalled();
    });
  });

  // ─── GET /share/:id ────────────────────────────────────────────────────────

  describe('GET /share/:id', () => {
    it('happy path: returns the share request row verbatim', async () => {
      const res = await app.inject({ method: 'GET', url: '/share/sr-abc-123?actor=alice' });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.share_id).toBe('sr-abc-123');
      expect(json.requester).toBe('alice');
      expect(json.status).toBe('pending');
      const arg = depsBag.repo.getShareRequest.mock.calls[0]![0];
      expect(arg.pool).toBe(depsBag.deps.pool);
      expect(arg.actor).toBe('alice');
      expect(arg.shareId).toBe('sr-abc-123');
    });

    it('400 when actor query param is missing', async () => {
      const res = await app.inject({ method: 'GET', url: '/share/sr-abc-123' });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'validation failed', issues: expect.any(Array) });
      expect(depsBag.repo.getShareRequest).not.toHaveBeenCalled();
    });

    it('404 when repo returns not_found', async () => {
      depsBag.repo.getShareRequest.mockResolvedValueOnce({ error: 'not_found' });
      const res = await app.inject({ method: 'GET', url: '/share/missing-id?actor=alice' });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: 'share request not found' });
    });

    it('403 when repo returns forbidden', async () => {
      depsBag.repo.getShareRequest.mockResolvedValueOnce({ error: 'forbidden' });
      const res = await app.inject({ method: 'GET', url: '/share/sr-abc-123?actor=eve' });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: 'not the requester or reviewer' });
    });
  });

  // ─── POST /share/:id/decide ────────────────────────────────────────────────

  describe('POST /share/:id/decide', () => {
    const validBody = { actor: 'li86', decision: 'approve' };

    it('happy path (approve): returns ok+status+promotion_result', async () => {
      const promotionResult = { promoted_memory_id: 'mem-org-1', deduped: false };
      depsBag.repo.decideShareRequest.mockResolvedValueOnce({
        ok:               true,
        status:           'approved',
        promotion_result: promotionResult,
      });
      const res = await app.inject({ method: 'POST', url: '/share/sr-abc-123/decide', payload: validBody });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, status: 'approved', promotion_result: promotionResult });
      const arg = depsBag.repo.decideShareRequest.mock.calls[0]![0];
      expect(arg.pool).toBe(depsBag.deps.pool);
      expect(arg.actor).toBe('li86');
      expect(arg.manager).toBe('li86');
      expect(arg.shareId).toBe('sr-abc-123');
      expect(arg.decision).toBe('approve');
    });

    it('happy path (reject): no promotion_result in response', async () => {
      depsBag.repo.decideShareRequest.mockResolvedValueOnce({ ok: true, status: 'rejected' });
      const res = await app.inject({
        method:  'POST',
        url:     '/share/sr-abc-123/decide',
        payload: { actor: 'li86', decision: 'reject', comment: 'not ready' },
      });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.ok).toBe(true);
      expect(json.status).toBe('rejected');
      expect(json.promotion_result).toBeUndefined();
    });

    it('400 when decision field is missing', async () => {
      const res = await app.inject({ method: 'POST', url: '/share/sr-abc-123/decide', payload: { actor: 'li86' } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'validation failed', issues: expect.any(Array) });
      expect(depsBag.repo.decideShareRequest).not.toHaveBeenCalled();
    });

    it('404 when repo returns not_found', async () => {
      depsBag.repo.decideShareRequest.mockResolvedValueOnce({ ok: false, reason: 'not_found' });
      const res = await app.inject({ method: 'POST', url: '/share/missing/decide', payload: validBody });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: 'share request not found' });
    });

    it('403 when repo returns forbidden', async () => {
      depsBag.repo.decideShareRequest.mockResolvedValueOnce({ ok: false, reason: 'forbidden' });
      const res = await app.inject({ method: 'POST', url: '/share/sr-abc-123/decide', payload: { actor: 'eve', decision: 'approve' } });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: 'not the manager' });
    });

    it('409 when repo returns already_decided', async () => {
      depsBag.repo.decideShareRequest.mockResolvedValueOnce({ ok: false, reason: 'already_decided', detail: 'approved' });
      const res = await app.inject({ method: 'POST', url: '/share/sr-abc-123/decide', payload: validBody });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'already approved' });
    });

    it('422 when repo returns collision', async () => {
      depsBag.repo.decideShareRequest.mockResolvedValueOnce({ ok: false, reason: 'collision', detail: 'shared/skills/demo already exists' });
      const res = await app.inject({ method: 'POST', url: '/share/sr-abc-123/decide', payload: validBody });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ error: 'name collision' });
    });

    it('422 when repo returns promotion_failed with detail', async () => {
      depsBag.repo.decideShareRequest.mockResolvedValueOnce({ ok: false, reason: 'promotion_failed', detail: 'snapshot malformed' });
      const res = await app.inject({ method: 'POST', url: '/share/sr-abc-123/decide', payload: validBody });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ error: 'snapshot malformed' });
    });

    it('422 with fallback message when promotion_failed has no detail', async () => {
      depsBag.repo.decideShareRequest.mockResolvedValueOnce({ ok: false, reason: 'promotion_failed' });
      const res = await app.inject({ method: 'POST', url: '/share/sr-abc-123/decide', payload: validBody });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ error: 'promotion failed' });
    });
  });

  // ─── POST /share/:id/withdraw ──────────────────────────────────────────────

  describe('POST /share/:id/withdraw', () => {
    const validBody = { actor: 'alice' };

    it('happy path: returns ok+status=withdrawn', async () => {
      const res = await app.inject({ method: 'POST', url: '/share/sr-abc-123/withdraw', payload: validBody });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, status: 'withdrawn' });
      const arg = depsBag.repo.withdrawShareRequest.mock.calls[0]![0];
      expect(arg.pool).toBe(depsBag.deps.pool);
      expect(arg.actor).toBe('alice');
      expect(arg.shareId).toBe('sr-abc-123');
    });

    it('400 when actor is missing from body', async () => {
      const res = await app.inject({ method: 'POST', url: '/share/sr-abc-123/withdraw', payload: {} });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'validation failed', issues: expect.any(Array) });
      expect(depsBag.repo.withdrawShareRequest).not.toHaveBeenCalled();
    });

    it('404 when repo returns not_found', async () => {
      depsBag.repo.withdrawShareRequest.mockResolvedValueOnce({ ok: false, reason: 'not_found' });
      const res = await app.inject({ method: 'POST', url: '/share/missing/withdraw', payload: validBody });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: 'share request not found' });
    });

    it('403 when repo returns forbidden', async () => {
      depsBag.repo.withdrawShareRequest.mockResolvedValueOnce({ ok: false, reason: 'forbidden' });
      const res = await app.inject({ method: 'POST', url: '/share/sr-abc-123/withdraw', payload: { actor: 'eve' } });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: 'not the requester' });
    });

    it('409 when repo returns already_decided', async () => {
      depsBag.repo.withdrawShareRequest.mockResolvedValueOnce({ ok: false, reason: 'already_decided' });
      const res = await app.inject({ method: 'POST', url: '/share/sr-abc-123/withdraw', payload: validBody });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'already decided' });
    });
  });

  // ─── Route ordering: /share/list and /share/capabilities are not swallowed ─

  describe('route ordering sanity', () => {
    it('/share/list is matched as literal, not as :id', async () => {
      // If /share/:id were registered first, this would call getShareRequest
      // with shareId='list', not listShareRequests at all.
      const res = await app.inject({ method: 'GET', url: '/share/list?actor=alice&role=outbox' });
      expect(res.statusCode).toBe(200);
      expect(depsBag.repo.listShareRequests).toHaveBeenCalledTimes(1);
      expect(depsBag.repo.getShareRequest).not.toHaveBeenCalled();
    });

    it('/share/capabilities is matched as literal, not as :id', async () => {
      const res = await app.inject({ method: 'GET', url: '/share/capabilities?actor=li86' });
      expect(res.statusCode).toBe(200);
      expect(depsBag.repo.getShareCapabilities).toHaveBeenCalledTimes(1);
      expect(depsBag.repo.getShareRequest).not.toHaveBeenCalled();
    });
  });
});
