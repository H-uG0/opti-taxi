# Optimizer service: FastAPI + Google OR-Tools. Build context: services/optimizer.
#   docker compose up -d --build optimizer      ->  http://localhost:8100/health
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /srv/optimizer

RUN groupadd --system --gid 10001 optimizer \
    && useradd --system --uid 10001 --gid optimizer --home-dir /srv/optimizer --shell /usr/sbin/nologin optimizer

# Dependencies first, in their own cached layer (they change far less often than the code).
COPY pyproject.toml ./
RUN python -c "import tomllib; print('\n'.join(tomllib.load(open('pyproject.toml', 'rb'))['project']['dependencies']))" \
        > /tmp/requirements.txt \
    && pip install -r /tmp/requirements.txt \
    && rm /tmp/requirements.txt

COPY app ./app
RUN pip install --no-deps . && rm -rf build ./*.egg-info

USER optimizer
EXPOSE 8100
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8100"]
