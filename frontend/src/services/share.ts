// frontend/src/services/share.ts
import { natsService } from './nats';
import type {
  ShareRequest, ShareCapabilities, ArtifactKind, ShareStatus,
} from '@/types/share';

export interface ListResponse {
  items: ShareRequest[];
  next_cursor: string | null;
}

export interface SubmitResponse { share_id: string; }
export interface DecideResponse { status: ShareStatus; promotion_result?: Record<string, unknown>; }
export interface WithdrawResponse { status: ShareStatus; }

export const shareService = {
  /**
   * Submit a memory/skill/folder for org review.
   * Phase 1: only memory kind is implemented server-side; skill/folder return 501.
   */
  submit: async (p: { kind: ArtifactKind; ref: string; note?: string }): Promise<SubmitResponse> => {
    const result = await natsService.invoke('share_submit', p as unknown as Record<string, unknown>) as { success: true; share_id: string };
    return { share_id: result.share_id };
  },

  /**
   * List share requests scoped to the current actor.
   * - role='outbox': my submissions (any status)
   * - role='inbox':  pending requests where I'm the reviewer (managers only — empty for non-managers)
   * - role='all':    union of outbox and inbox
   */
  list: async (q: { role: 'outbox'|'inbox'|'all'; status?: ShareStatus; limit?: number; cursor?: string }): Promise<ListResponse> => {
    const result = await natsService.invoke('share_list', q as unknown as Record<string, unknown>) as { success: true; items: ShareRequest[]; next_cursor: string | null };
    return { items: result.items, next_cursor: result.next_cursor };
  },

  /**
   * Fetch a single share request by id. Owner-or-reviewer-only.
   */
  get: async (id: string): Promise<ShareRequest> => {
    const result = await natsService.invoke('share_get', { share_id: id }) as { success: true; share: ShareRequest };
    return result.share;
  },

  /**
   * Manager-only: approve or reject a pending request.
   */
  decide: async (id: string, p: { decision: 'approve'|'reject'; comment?: string }): Promise<DecideResponse> => {
    const result = await natsService.invoke('share_decide', { share_id: id, ...p }) as { success: true; status: ShareStatus; promotion_result?: Record<string, unknown> };
    return { status: result.status, promotion_result: result.promotion_result };
  },

  /**
   * Requester-only: withdraw a pending request.
   */
  withdraw: async (id: string): Promise<WithdrawResponse> => {
    const result = await natsService.invoke('share_withdraw', { share_id: id }) as { success: true; status: ShareStatus };
    return { status: result.status };
  },

  /**
   * Bootstrap call: returns is_manager + pending_inbox_count + actor_username.
   * Used by SharePanel to decide whether to render the Inbox tab and to render
   * the (N) badge on the panel button.
   */
  capabilities: async (): Promise<ShareCapabilities> => {
    const result = await natsService.invoke('share_capabilities', {}) as { success: true } & ShareCapabilities;
    return {
      is_manager: result.is_manager,
      manager_username: result.manager_username,
      pending_inbox_count: result.pending_inbox_count,
      actor_username: result.actor_username,
    };
  },

  /**
   * Phase 2: fetch a single file from a frozen skill snapshot via the adapter
   * HTTP proxy. Used by ShareDetail's "click a file to preview" UX. Returns
   * the file body as text — the indexer route caps the file size implicitly
   * (skills are small; folders defer to phase 3).
   */
  fetchSnapshotFile: async (id: string, relPath: string): Promise<string> => {
    const url = `/share-snapshot/${encodeURIComponent(id)}/file?path=${encodeURIComponent(relPath)}`;
    // Same-origin request — nginx HTTP Basic Auth is carried automatically; no `credentials` flag needed.
    const r = await fetch(url);
    if (!r.ok) {
      throw new Error(`snapshot file fetch failed (HTTP ${r.status})`);
    }
    return await r.text();
  },
} as const;
