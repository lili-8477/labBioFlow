from fastapi.testclient import TestClient
from server import app, EMBED_DIM

client = TestClient(app)


def test_embed_returns_vectors_of_correct_dim():
    r = client.post("/embed", json={"texts": ["hello", "world"]})
    assert r.status_code == 200
    body = r.json()
    assert "vectors" in body
    assert len(body["vectors"]) == 2
    for v in body["vectors"]:
        assert len(v) == EMBED_DIM
        assert all(isinstance(x, float) for x in v)


def test_embed_rejects_empty_input():
    r = client.post("/embed", json={"texts": []})
    assert r.status_code == 400


def test_embed_rejects_oversize_batch():
    r = client.post("/embed", json={"texts": ["x"] * 1000})
    assert r.status_code == 400


def test_health_endpoint():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["model"] == "BAAI/bge-small-en-v1.5"
