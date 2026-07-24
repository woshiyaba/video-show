FROM node:22-alpine AS frontend-builder

ARG NPM_REGISTRY=https://registry.npmmirror.com

WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --registry="${NPM_REGISTRY}"
COPY frontend/ ./
RUN npm run build

FROM python:3.13-slim AS runtime

ARG DEBIAN_MIRROR=https://mirrors.tuna.tsinghua.edu.cn/debian
ARG DEBIAN_SECURITY_MIRROR=https://mirrors.tuna.tsinghua.edu.cn/debian-security
ARG PIP_INDEX_URL=https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DATABASE_URL=sqlite:////app/data/video_show.db \
    FRONTEND_DIR=/app/frontend/dist

WORKDIR /app
COPY pyproject.toml README.md ./
COPY app ./app
RUN sed -i \
        -e "s|http://deb.debian.org/debian-security|${DEBIAN_SECURITY_MIRROR}|g" \
        -e "s|https://deb.debian.org/debian-security|${DEBIAN_SECURITY_MIRROR}|g" \
        -e "s|http://deb.debian.org/debian|${DEBIAN_MIRROR}|g" \
        -e "s|https://deb.debian.org/debian|${DEBIAN_MIRROR}|g" \
        -e "s|http://security.debian.org/debian-security|${DEBIAN_SECURITY_MIRROR}|g" \
        -e "s|https://security.debian.org/debian-security|${DEBIAN_SECURITY_MIRROR}|g" \
        /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && python -m pip install --no-cache-dir --index-url "${PIP_INDEX_URL}" . \
    && apt-get purge -y --auto-remove build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY --from=frontend-builder /build/frontend/dist ./frontend/dist
RUN mkdir -p /app/data

EXPOSE 8002
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8002/video-show/api/health', timeout=3)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8002"]
