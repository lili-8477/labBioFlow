FROM python:3.12-slim

WORKDIR /app

RUN pip install --no-cache-dir \
      "fastapi==0.115.4" \
      "uvicorn[standard]==0.32.0" \
      "sentence-transformers==3.2.1" \
      "pydantic==2.9.2"

# Pre-download model weights into the image so first request is fast and
# the container has no runtime network dependency for the model.
RUN python -c "from sentence_transformers import SentenceTransformer; \
               SentenceTransformer('BAAI/bge-small-en-v1.5')"

COPY server.py ./

EXPOSE 8000
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
