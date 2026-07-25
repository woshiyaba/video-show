from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from app.api import (
    _cleanup_expired_uploads,
    _cleanup_pending_sources,
    router,
)
from app.config import APP_PREFIX, get_settings
from app.cos_service import get_cos_service
from app.database import Base, SessionLocal, engine, ensure_schema


@asynccontextmanager
async def lifespan(_: FastAPI):
    Base.metadata.create_all(bind=engine)
    ensure_schema(engine)
    if settings.cos_is_configured:
        try:
            with SessionLocal() as session:
                cos = get_cos_service()
                _cleanup_expired_uploads(session, cos)
                _cleanup_pending_sources(session, cos)
        except Exception:
            # A temporary COS outage must not prevent the web application from
            # starting; stale sessions will be retried on the next upload.
            pass
    yield


settings = get_settings()
app = FastAPI(
    title=settings.app_name,
    version="0.1.0",
    lifespan=lifespan,
    docs_url=f"{APP_PREFIX}/docs",
    redoc_url=f"{APP_PREFIX}/redoc",
    openapi_url=f"{APP_PREFIX}/openapi.json",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(router)

frontend_dir = settings.frontend_dir.resolve()
assets_dir = frontend_dir / "assets"
if assets_dir.is_dir():
    app.mount(
        f"{APP_PREFIX}/assets",
        StaticFiles(directory=assets_dir),
        name="assets",
    )


@app.get("/", include_in_schema=False)
def redirect_root():
    return RedirectResponse(url=f"{APP_PREFIX}/", status_code=308)


@app.get(APP_PREFIX, include_in_schema=False)
def redirect_prefixed_root():
    return RedirectResponse(url=f"{APP_PREFIX}/", status_code=308)


@app.get(f"{APP_PREFIX}/{{full_path:path}}", include_in_schema=False)
def serve_frontend(full_path: str):
    if full_path.startswith("api/"):
        raise HTTPException(status_code=404, detail="接口不存在")
    requested = (frontend_dir / full_path).resolve()
    if (
        full_path
        and requested.is_file()
        and frontend_dir in requested.parents
    ):
        return FileResponse(requested)
    index = frontend_dir / "index.html"
    if index.is_file():
        return FileResponse(index)
    raise HTTPException(
        status_code=404,
        detail="前端尚未构建，请运行 npm run build",
    )
