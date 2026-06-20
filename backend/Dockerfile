# Voice Agent backend — FastAPI + faster-whisper + Gemini
FROM python:3.13-slim

# libgomp1 is the OpenMP runtime needed by ctranslate2 (faster-whisper).
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for better layer caching.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV WHISPER_MODEL=base \
    WHISPER_PRELOAD=1 \
    HF_HOME=/root/.cache/huggingface \
    PYTHONUNBUFFERED=1

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
