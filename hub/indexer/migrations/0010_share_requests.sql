-- 0010_share_requests.sql
-- Share-to-org promotion queue. One row per submission. State machine:
--   pending → approved | rejected | withdrawn (terminal).
-- Frozen JSONB snapshot at submission time so manager reviews what was
-- submitted, not whatever the source looks like at decision time.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE share_requests (
  share_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_kind   text NOT NULL CHECK (artifact_kind IN ('memory', 'skill', 'folder')),
  artifact_ref    text NOT NULL,
  snapshot_meta   jsonb NOT NULL,
  requester       text NOT NULL,
  reviewer        text NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  requester_note  text,
  review_comment  text,
  promotion_result jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  decided_at      timestamptz
);

CREATE INDEX share_requests_status_created_idx
  ON share_requests (status, created_at DESC);

CREATE INDEX share_requests_requester_idx
  ON share_requests (requester, created_at DESC);

CREATE INDEX share_requests_reviewer_pending_idx
  ON share_requests (reviewer, created_at DESC)
  WHERE status = 'pending';
