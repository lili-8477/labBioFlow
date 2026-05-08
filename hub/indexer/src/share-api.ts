import * as path from 'node:path';
import { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type {
  submitShareRequest,
  listShareRequests,
  getShareRequest,
  decideShareRequest,
  withdrawShareRequest,
  getShareCapabilities,
} from './share-repo.js';
import { extractSingleFile } from './share-fs.js';

export interface ShareApiDeps {
  pool:               Pool;
  manager:            string | null;
  workspacesRoot:     string;
  shareSnapshotsDir:  string;
  repo: {
    submitShareRequest:   typeof submitShareRequest;
    listShareRequests:    typeof listShareRequests;
    getShareRequest:      typeof getShareRequest;
    decideShareRequest:   typeof decideShareRequest;
    withdrawShareRequest: typeof withdrawShareRequest;
    getShareCapabilities: typeof getShareCapabilities;
  };
}

// ─── Zod schemas ────────────────────────────────────────────────────────────

const SubmitBody = z.object({
  requester: z.string().min(1),
  kind:      z.enum(['memory', 'skill', 'folder']),
  ref:       z.string().min(1),
  note:      z.string().max(500).optional(),
});

const ListQuery = z.object({
  actor:  z.string().min(1),
  role:   z.enum(['outbox', 'inbox', 'all']),
  status: z.enum(['pending', 'approved', 'rejected', 'withdrawn']).optional(),
  limit:  z.coerce.number().int().positive().max(200).optional(),
  cursor: z.string().optional(), // tuple cursor "ISO|uuid"; not validateable as plain ISO
});

const GetQuery          = z.object({ actor: z.string().min(1) });
const DecideBody        = z.object({
  actor:    z.string().min(1),
  decision: z.enum(['approve', 'reject']),
  comment:  z.string().max(2000).optional(),
});
const WithdrawBody      = z.object({ actor: z.string().min(1) });
const CapabilitiesQuery = z.object({ actor: z.string().min(1) });

const SnapshotFileQuery = z.object({
  actor: z.string().min(1),
  path:  z.string().min(1),
});

// ─── Plugin factory ─────────────────────────────────────────────────────────

// Call shareRoutesPlugin(deps) to get an async fastify plugin you can pass to
// app.register(...). Closes over deps so routes have pool/manager/repo without
// threading them through route signatures.
export function shareRoutesPlugin(deps: ShareApiDeps) {
  return async function (instance: FastifyInstance) {

    // POST /share/submit
    instance.post('/share/submit', async (req, reply) => {
      if (deps.manager === null) {
        reply.code(503);
        return { error: 'sharing disabled — no manager configured' };
      }
      const parsed = SubmitBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'validation failed', issues: parsed.error.issues };
      }
      const b = parsed.data;
      const result = await deps.repo.submitShareRequest({
        pool:              deps.pool,
        manager:           deps.manager,
        requester:         b.requester,
        kind:              b.kind,
        ref:               b.ref,
        note:              b.note,
        workspacesRoot:    deps.workspacesRoot,
        shareSnapshotsDir: deps.shareSnapshotsDir,
      });
      if (result.ok) {
        return { share_id: result.share_id };
      }
      switch (result.reason) {
        case 'no_manager':
          reply.code(503); return { error: 'sharing disabled' };
        case 'not_implemented':
          reply.code(501); return { error: `kind ${b.kind} not yet implemented` };
        case 'forbidden':
          reply.code(403); return { error: 'source not found or not owned by requester' };
        case 'invalid_ref':
          reply.code(400); return { error: 'invalid ref' };
        case 'source_not_found':
          reply.code(404); return { error: 'source not found', detail: result.detail };
        case 'missing_manifest':
          reply.code(400); return { error: 'skill is missing SKILL.md' };
        case 'snapshot_failed':
          reply.code(500); return { error: 'snapshot failed', detail: result.detail };
      }
    });

    // GET /share/list — registered BEFORE GET /share/:id so fastify's radix
    // tree matches the literal "list" segment before the dynamic :id wildcard.
    instance.get('/share/list', async (req, reply) => {
      const parsed = ListQuery.safeParse(req.query);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'validation failed', issues: parsed.error.issues };
      }
      const q = parsed.data;
      return await deps.repo.listShareRequests({
        pool:    deps.pool,
        actor:   q.actor,
        manager: deps.manager,
        role:    q.role,
        status:  q.status,
        limit:   q.limit,
        cursor:  q.cursor,
      });
    });

    // GET /share/capabilities — registered BEFORE GET /share/:id for the same
    // reason as /share/list above.
    instance.get('/share/capabilities', async (req, reply) => {
      const parsed = CapabilitiesQuery.safeParse(req.query);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'validation failed', issues: parsed.error.issues };
      }
      return await deps.repo.getShareCapabilities({
        pool:    deps.pool,
        actor:   parsed.data.actor,
        manager: deps.manager,
      });
    });

    // POST /share/:id/decide — literal suffix after param; does not conflict
    // with bare GET /share/:id.
    instance.post<{ Params: { id: string } }>('/share/:id/decide', async (req, reply) => {
      const parsed = DecideBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'validation failed', issues: parsed.error.issues };
      }
      const b = parsed.data;
      const result = await deps.repo.decideShareRequest({
        pool:              deps.pool,
        actor:             b.actor,
        manager:           deps.manager,
        shareId:           req.params.id,
        decision:          b.decision,
        comment:           b.comment,
        workspacesRoot:    deps.workspacesRoot,
        shareSnapshotsDir: deps.shareSnapshotsDir,
      });
      if (result.ok) {
        return { ok: true, status: result.status, ...(result.promotion_result !== undefined ? { promotion_result: result.promotion_result } : {}) };
      }
      if (result.reason === 'not_found') {
        reply.code(404);
        return { error: 'share request not found' };
      }
      if (result.reason === 'forbidden') {
        reply.code(403);
        return { error: 'not the manager' };
      }
      if (result.reason === 'already_decided') {
        reply.code(409);
        return { error: `already ${result.detail}` };
      }
      if (result.reason === 'collision') {
        reply.code(422);
        return { error: 'name collision', detail: result.detail };
      }
      // promotion_failed
      reply.code(422);
      return { error: result.detail ?? 'promotion failed' };
    });

    // POST /share/:id/withdraw
    instance.post<{ Params: { id: string } }>('/share/:id/withdraw', async (req, reply) => {
      const parsed = WithdrawBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'validation failed', issues: parsed.error.issues };
      }
      const result = await deps.repo.withdrawShareRequest({
        pool:    deps.pool,
        actor:   parsed.data.actor,
        shareId: req.params.id,
      });
      if (result.ok) {
        return { ok: true, status: 'withdrawn' };
      }
      if (result.reason === 'not_found') {
        reply.code(404);
        return { error: 'share request not found' };
      }
      if (result.reason === 'forbidden') {
        reply.code(403);
        return { error: 'not the requester' };
      }
      // already_decided
      reply.code(409);
      return { error: 'already decided' };
    });

    // GET /share/:id/snapshot/file — registered BEFORE bare GET /share/:id so
    // fastify's radix tree picks the literal "/snapshot/file" suffix first.
    instance.get<{ Params: { id: string } }>('/share/:id/snapshot/file', async (req, reply) => {
      const parsed = SnapshotFileQuery.safeParse(req.query);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'validation failed', issues: parsed.error.issues };
      }
      const { actor, path: relPath } = parsed.data;

      const got = await deps.repo.getShareRequest({
        pool:    deps.pool,
        actor,
        shareId: req.params.id,
      });
      if ('error' in got) {
        reply.code(got.error === 'not_found' ? 404 : 403);
        return { error: got.error };
      }
      if (got.artifact_kind !== 'skill') {
        reply.code(400);
        return { error: 'snapshot/file only valid for skill kind' };
      }

      const tarPath = path.join(deps.shareSnapshotsDir, `${req.params.id}.tar.gz`);
      const buf = await extractSingleFile({ srcTar: tarPath, path: relPath });
      if (buf === null) {
        reply.code(404);
        return { error: 'file not in snapshot' };
      }

      // Hardcoded mime sniffing — no new dep. Keep tight.
      const mt = relPath.endsWith('.md')   ? 'text/markdown'
               : relPath.endsWith('.json') ? 'application/json'
               : relPath.endsWith('.txt')  ? 'text/plain'
               : relPath.endsWith('.py')   ? 'text/x-python'
               : 'application/octet-stream';

      reply.header('Content-Type', mt);
      reply.header('Content-Length', buf.byteLength.toString());
      reply.header('Cache-Control', 'private, max-age=300');
      return reply.send(buf);
    });

    // GET /share/:id — must be registered AFTER literal /share/* routes so
    // fastify's radix tree prefers static segments over the :id wildcard.
    instance.get<{ Params: { id: string } }>('/share/:id', async (req, reply) => {
      const parsed = GetQuery.safeParse(req.query);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'validation failed', issues: parsed.error.issues };
      }
      const result = await deps.repo.getShareRequest({
        pool:    deps.pool,
        actor:   parsed.data.actor,
        shareId: req.params.id,
      });
      if ('error' in result) {
        if (result.error === 'not_found') {
          reply.code(404);
          return { error: 'share request not found' };
        }
        // forbidden
        reply.code(403);
        return { error: 'not the requester or reviewer' };
      }
      return result;
    });
  };
}
