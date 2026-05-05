"""Tiny embedding service for claude-bioflow.

Single endpoint /embed wraps sentence-transformers BAAI/bge-small-en-v1.5.
Model is loaded at import time so the first request is fast, even though
that means a slower process boot.
"""
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from sentence_transformers import SentenceTransformer

MODEL_NAME = "BAAI/bge-small-en-v1.5"
EMBED_DIM = 384
MAX_BATCH = 256

app = FastAPI(title="claude-bioflow-embedder")
_model = SentenceTransformer(MODEL_NAME, device="cpu")


class EmbedRequest(BaseModel):
    texts: list[str] = Field(min_length=0)


class EmbedResponse(BaseModel):
    vectors: list[list[float]]


@app.get("/health")
def health() -> dict:
    return {"model": MODEL_NAME, "dim": EMBED_DIM}


@app.post("/embed", response_model=EmbedResponse)
def embed(req: EmbedRequest) -> EmbedResponse:
    if len(req.texts) == 0:
        raise HTTPException(status_code=400, detail="texts must be non-empty")
    if len(req.texts) > MAX_BATCH:
        raise HTTPException(status_code=400, detail=f"batch size > {MAX_BATCH}")
    vecs = _model.encode(req.texts, normalize_embeddings=True).tolist()
    return EmbedResponse(vectors=vecs)
