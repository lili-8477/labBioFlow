// frontend/src/types/share.ts
export type ArtifactKind = 'memory' | 'skill' | 'folder';
export type ShareStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';

export interface ShareRequest {
  share_id: string;
  artifact_kind: ArtifactKind;
  artifact_ref: string;
  // shape varies by kind. memory:
  //   { name, description, body, type, source, hit_count, last_hit_at, facets }
  snapshot_meta: Record<string, unknown>;
  requester: string;
  reviewer: string;
  status: ShareStatus;
  requester_note: string | null;
  review_comment: string | null;
  promotion_result: Record<string, unknown> | null;
  created_at: string;     // ISO
  decided_at: string | null;
}

export interface ShareCapabilities {
  is_manager: boolean;
  manager_username: string | null;
  pending_inbox_count: number;
  actor_username: string;
}
