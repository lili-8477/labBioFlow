CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE memory_chunks (
  chunk_id     BIGSERIAL PRIMARY KEY,
  memory_id    UUID NOT NULL REFERENCES memories(memory_id) ON DELETE CASCADE,
  chunk_idx    INT  NOT NULL,
  content      TEXT NOT NULL,
  embedding    vector(384),
  tsv          tsvector
                 GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  UNIQUE (memory_id, chunk_idx)
);

CREATE INDEX memory_chunks_tsv_idx
  ON memory_chunks USING GIN (tsv);

CREATE INDEX memory_chunks_embedding_idx
  ON memory_chunks USING hnsw (embedding vector_cosine_ops);
