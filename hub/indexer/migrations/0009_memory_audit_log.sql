CREATE TABLE memory_audit_log (
  audit_id     BIGSERIAL PRIMARY KEY,
  memory_id    UUID NOT NULL REFERENCES memories(memory_id) ON DELETE CASCADE,
  actor        TEXT NOT NULL,
  action       TEXT NOT NULL CHECK (action IN ('write', 'update', 'forget', 'restore')),
  before       JSONB,
  after        JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX memory_audit_memory_idx ON memory_audit_log (memory_id, created_at DESC);
CREATE INDEX memory_audit_actor_idx  ON memory_audit_log (actor, created_at DESC);
