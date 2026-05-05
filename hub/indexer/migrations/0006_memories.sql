CREATE TABLE memories (
  memory_id          UUID PRIMARY KEY,
  username           TEXT NOT NULL,
  project_dir        TEXT,
  type               TEXT NOT NULL CHECK (type IN (
                       'user','feedback','project','reference',
                       'session_summary','observation'
                     )),
  source             TEXT NOT NULL CHECK (source IN ('user','distilled')),
  name               TEXT NOT NULL,
  description        TEXT NOT NULL,
  body               TEXT NOT NULL,
  source_session_id  UUID,
  source_entry_uuids JSONB NOT NULL DEFAULT '[]'::jsonb,
  content_hash       BYTEA NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  hit_count          INT  NOT NULL DEFAULT 0,
  last_hit_at        TIMESTAMPTZ,
  deleted_at         TIMESTAMPTZ,
  UNIQUE (username, project_dir, type, content_hash)
);

CREATE INDEX memories_username_type_created_idx
  ON memories (username, type, created_at DESC) WHERE deleted_at IS NULL;

CREATE INDEX memories_org_type_created_idx
  ON memories (type, created_at DESC) WHERE username = '__org__' AND deleted_at IS NULL;

CREATE INDEX memories_project_idx
  ON memories (username, project_dir, type)
  WHERE project_dir IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX memories_source_session_idx
  ON memories (source_session_id) WHERE source_session_id IS NOT NULL;
