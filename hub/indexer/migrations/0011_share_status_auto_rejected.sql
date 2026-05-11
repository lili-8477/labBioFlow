-- 0011_share_status_auto_rejected.sql
-- Add 'auto_rejected' to share_requests.status. Distinct from manual 'rejected'
-- so we can tell apart "reviewer rejected with comment" from "request aged out
-- without review". See phase-4 auto-close-on-idle plan.

ALTER TABLE share_requests
  DROP CONSTRAINT share_requests_status_check;

ALTER TABLE share_requests
  ADD CONSTRAINT share_requests_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn', 'auto_rejected'));
