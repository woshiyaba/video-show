import {
  AlertTriangle,
  Check,
  FileVideo,
  Image as ImageIcon,
  Pencil,
  RefreshCw,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";
import {
  ChangeEvent,
  DragEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  apiFetch,
  clearMediaDetailCache,
  deleteMedia,
  listMedia,
  renameMedia,
} from "../api";
import {
  formatBytes,
  formatDate,
  inferMediaType,
  prepareMedia,
  titleFromFilename,
} from "../media-utils";
import type { MediaCardData, UploadMetadata } from "../types";
import {
  UploadCancelledError,
  UploadController,
  uploadMedia,
} from "../upload";

type QueueStatus =
  | "preparing"
  | "ready"
  | "uploading"
  | "success"
  | "error"
  | "cancelled";

interface QueueItem {
  id: string;
  file: File;
  title: string;
  status: QueueStatus;
  progress: number;
  previewUrl?: string;
  metadata?: UploadMetadata;
  error?: string;
  cloudProcessing?: boolean;
}

function UploadQueue({ onUploaded }: { onUploaded: () => void }) {
  const [items, setItems] = useState<QueueItem[]>([]);
  const itemsRef = useRef(items);
  const controllers = useRef(new Map<string, UploadController>());
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploadingAll, setUploadingAll] = useState(false);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(
    () => () => {
      itemsRef.current.forEach((item) => {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      });
      controllers.current.forEach((controller) => controller.abort());
    },
    [],
  );

  const patchItem = useCallback((id: string, patch: Partial<QueueItem>) => {
    setItems((current) =>
      current.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  }, []);

  const addFiles = useCallback(
    (files: File[]) => {
      files.forEach((file) => {
        const id = crypto.randomUUID();
        const kind = inferMediaType(file);
        const base: QueueItem = {
          id,
          file,
          title: titleFromFilename(file.name),
          status: kind ? "preparing" : "error",
          progress: 0,
          error: kind ? undefined : "不支持这种文件格式",
        };
        setItems((current) => [...current, base]);
        if (!kind) return;

        prepareMedia(file)
          .then((metadata) => {
            const previewUrl = URL.createObjectURL(metadata.thumbnail);
            patchItem(id, {
              metadata,
              previewUrl,
              status: "ready",
            });
          })
          .catch((reason: Error) => {
            patchItem(id, { status: "error", error: reason.message });
          });
      });
    },
    [patchItem],
  );

  const onInput = (event: ChangeEvent<HTMLInputElement>) => {
    addFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    addFiles(Array.from(event.dataTransfer.files));
  };

  const uploadOne = useCallback(
    async (item: QueueItem) => {
      if (!item.metadata || !item.title.trim()) {
        patchItem(item.id, {
          status: "error",
          error: item.title.trim() ? "媒体尚未准备完成" : "请输入展示名称",
        });
        return;
      }
      const controller = new UploadController();
      controllers.current.set(item.id, controller);
      patchItem(item.id, { status: "uploading", progress: 0, error: undefined });
      try {
        const uploaded = await uploadMedia({
          file: item.file,
          title: item.title,
          metadata: item.metadata,
          controller,
          onProgress: (progress) => patchItem(item.id, { progress }),
        });
        patchItem(item.id, {
          status: "success",
          progress: 100,
          cloudProcessing: uploaded.processing_status === "processing",
        });
        clearMediaDetailCache();
        onUploaded();
      } catch (reason) {
        if (reason instanceof UploadCancelledError) {
          patchItem(item.id, {
            status: "cancelled",
            error: "上传已取消",
          });
        } else {
          patchItem(item.id, {
            status: "error",
            error: reason instanceof Error ? reason.message : "上传失败",
          });
        }
      } finally {
        controllers.current.delete(item.id);
      }
    },
    [onUploaded, patchItem],
  );

  const uploadAll = async () => {
    setUploadingAll(true);
    try {
      const candidates = itemsRef.current.filter((item) =>
        ["ready", "error", "cancelled"].includes(item.status),
      );
      for (const item of candidates) {
        if (item.metadata) await uploadOne(item);
      }
    } finally {
      setUploadingAll(false);
    }
  };

  const removeItem = (item: QueueItem) => {
    controllers.current.get(item.id)?.abort();
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    setItems((current) => current.filter((entry) => entry.id !== item.id));
  };

  const pendingCount = items.filter((item) =>
    ["ready", "error", "cancelled"].includes(item.status),
  ).length;

  return (
    <section className="admin-card upload-panel">
      <div className="admin-card-header">
        <div>
          <span className="eyebrow">上传到腾讯云 COS</span>
          <h2>添加新影像</h2>
          <p>文件由浏览器分块直传，不占用应用服务器带宽。</p>
        </div>
        {pendingCount > 0 && (
          <button
            className="primary-button"
            onClick={uploadAll}
            disabled={uploadingAll}
          >
            <UploadCloud size={18} />
            {uploadingAll ? "正在上传…" : `上传全部（${pendingCount}）`}
          </button>
        )}
      </div>

      <div
        className={`drop-zone ${dragging ? "dragging" : ""}`}
        onDragEnter={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") inputRef.current?.click();
        }}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="video/mp4,video/webm,video/ogg,image/jpeg,image/png,image/webp,image/gif,image/avif"
          onChange={onInput}
          hidden
        />
        <span className="drop-icon">
          <UploadCloud size={28} />
        </span>
        <strong>拖放视频或照片到这里</strong>
        <span>也可以点击选择文件 · 支持多选</span>
      </div>

      {items.length > 0 && (
        <div className="upload-queue">
          {items.map((item) => (
            <article className="upload-item" key={item.id}>
              <div className="upload-preview">
                {item.previewUrl ? (
                  <img src={item.previewUrl} alt="" />
                ) : inferMediaType(item.file) === "video" ? (
                  <FileVideo size={23} />
                ) : (
                  <ImageIcon size={23} />
                )}
              </div>
              <div className="upload-main">
                <input
                  className="title-input"
                  value={item.title}
                  maxLength={120}
                  aria-label={`${item.file.name}的展示名称`}
                  onChange={(event) =>
                    patchItem(item.id, { title: event.target.value })
                  }
                  disabled={item.status === "uploading" || item.status === "success"}
                />
                <div className="upload-meta">
                  <span>{item.file.name}</span>
                  <span>{formatBytes(item.file.size)}</span>
                  <span className={`status-label ${item.status}`}>
                    {item.status === "preparing" && "正在生成封面"}
                    {item.status === "ready" && "等待上传"}
                    {item.status === "uploading" && `${item.progress}%`}
                    {item.status === "success" &&
                      (item.cloudProcessing
                        ? "上传完成，云端压缩中"
                        : "上传完成")}
                    {item.status === "error" && (item.error ?? "上传失败")}
                    {item.status === "cancelled" && "已取消"}
                  </span>
                </div>
                {item.status === "uploading" && (
                  <div className="progress-track" aria-label={`上传进度 ${item.progress}%`}>
                    <span style={{ width: `${item.progress}%` }} />
                  </div>
                )}
              </div>
              <div className="upload-actions">
                {["ready", "error", "cancelled"].includes(item.status) &&
                  item.metadata && (
                    <button
                      className="icon-button accent"
                      onClick={() => uploadOne(item)}
                      aria-label="上传"
                    >
                      {item.status === "ready" ? (
                        <UploadCloud size={18} />
                      ) : (
                        <RefreshCw size={18} />
                      )}
                    </button>
                  )}
                {item.status === "uploading" && (
                  <button
                    className="icon-button danger"
                    onClick={() => controllers.current.get(item.id)?.abort()}
                    aria-label="取消上传"
                  >
                    <X size={18} />
                  </button>
                )}
                {item.status !== "uploading" && (
                  <button
                    className="icon-button"
                    onClick={() => removeItem(item)}
                    aria-label="移出列表"
                  >
                    <Trash2 size={17} />
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function MediaManager({ refreshKey }: { refreshKey: number }) {
  const [items, setItems] = useState<MediaCardData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback((silent = false) => {
    if (!silent) setLoading(true);
    setError("");
    listMedia(undefined, "", 1, 100)
      .then((result) => setItems(result.items))
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  useEffect(() => {
    if (!items.some((item) => item.processing_status === "processing")) {
      return;
    }
    const timer = setTimeout(() => load(true), 5_000);
    return () => clearTimeout(timer);
  }, [items, load]);

  const saveTitle = async (item: MediaCardData) => {
    const title = editingTitle.trim();
    if (!title) {
      setError("展示名称不能为空");
      return;
    }
    setBusyId(item.id);
    try {
      const updated = await renameMedia(item.id, title);
      setItems((current) =>
        current.map((entry) => (entry.id === item.id ? updated : entry)),
      );
      setEditingId(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "改名失败");
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (item: MediaCardData) => {
    if (!window.confirm(`确定删除“${item.title}”吗？COS 中的原文件也会删除。`)) {
      return;
    }
    setBusyId(item.id);
    try {
      await deleteMedia(item.id);
      setItems((current) => current.filter((entry) => entry.id !== item.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "删除失败");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="admin-card">
      <div className="admin-card-header">
        <div>
          <span className="eyebrow">内容管理</span>
          <h2>已上传影像</h2>
          <p>修改前台名称，或同时删除记录与 COS 文件。</p>
        </div>
        <span className="count-chip">{items.length} 项</span>
      </div>
      {error && (
        <div className="error-banner compact">
          <span>{error}</span>
          <button onClick={() => setError("")}>关闭</button>
        </div>
      )}
      {loading ? (
        <div className="admin-loading">正在读取媒体库…</div>
      ) : items.length === 0 ? (
        <div className="admin-empty">上传完成的内容会出现在这里。</div>
      ) : (
        <div className="manage-list">
          {items.map((item) => (
            <article className="manage-item" key={item.id}>
              <div className="manage-thumb">
                {item.thumbnail_url ? (
                  <img src={item.thumbnail_url} alt="" />
                ) : item.media_type === "video" ? (
                  <FileVideo size={22} />
                ) : (
                  <ImageIcon size={22} />
                )}
              </div>
              <div className="manage-content">
                {editingId === item.id ? (
                  <input
                    className="title-input"
                    value={editingTitle}
                    maxLength={120}
                    autoFocus
                    onChange={(event) => setEditingTitle(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void saveTitle(item);
                      if (event.key === "Escape") setEditingId(null);
                    }}
                  />
                ) : (
                  <strong>{item.title}</strong>
                )}
                <span>
                  {item.media_type === "video" ? "视频" : "照片"} ·{" "}
                  {formatBytes(
                    item.playback_size_bytes ?? item.size_bytes,
                  )}{" "}
                  · {formatDate(item.created_at)}
                  {item.processing_status === "processing" &&
                    " · 正在云端压缩"}
                  {item.processing_status === "failed" &&
                    " · 压缩失败，原片已保留"}
                  {item.playback_type === "hls" &&
                    item.playback_size_bytes != null &&
                    ` · 原片 ${formatBytes(item.size_bytes)}`}
                </span>
              </div>
              <div className="manage-actions">
                {editingId === item.id ? (
                  <>
                    <button
                      className="icon-button accent"
                      onClick={() => saveTitle(item)}
                      disabled={busyId === item.id}
                      aria-label="保存名称"
                    >
                      <Check size={18} />
                    </button>
                    <button
                      className="icon-button"
                      onClick={() => setEditingId(null)}
                      aria-label="取消编辑"
                    >
                      <X size={18} />
                    </button>
                  </>
                ) : (
                  <button
                    className="icon-button"
                    onClick={() => {
                      setEditingId(item.id);
                      setEditingTitle(item.title);
                    }}
                    aria-label="修改名称"
                  >
                    <Pencil size={17} />
                  </button>
                )}
                <button
                  className="icon-button danger"
                  onClick={() => remove(item)}
                  disabled={busyId === item.id}
                  aria-label="删除"
                >
                  <Trash2 size={17} />
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

export function AdminPage() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [corsWarning, setCorsWarning] = useState("");

  useEffect(() => {
    apiFetch<{
      cos_configured: boolean;
      cos: string;
      cos_cors: string;
      video_transcoding_enabled: boolean;
      video_transcoding: string;
    }>("/api/health?deep=true")
      .then((health) => {
        if (!health.cos_configured) {
          setCorsWarning("腾讯云 COS 尚未配置，当前无法上传或查看媒体。");
        } else if (health.cos === "error") {
          setCorsWarning("无法连接腾讯云 COS，请检查密钥、地域和 Bucket。");
        } else if (health.cos_cors === "missing") {
          setCorsWarning(
            "当前 COS 存储桶还没有 CORS 规则，浏览器直传会失败；请按 README 的配置表添加规则。",
          );
        } else if (health.cos_cors === "incomplete") {
          setCorsWarning(
            "COS 的 CORS 规则不完整，请确认允许 GET、HEAD、PUT 并暴露 ETag。",
          );
        } else if (
          health.video_transcoding_enabled &&
          health.video_transcoding === "incomplete"
        ) {
          setCorsWarning(
            "视频云压缩配置不完整，请检查工作流 ID 和回调令牌；修复前新视频上传会被拒绝。",
          );
        }
      })
      .catch(() => {
        // The normal upload request will still report a concrete backend error.
      });
  }, []);

  return (
    <main className="page-shell admin-shell">
      <section className="admin-intro">
        <div>
          <span className="eyebrow">管理后台</span>
          <h1>整理你的私人影像馆</h1>
          <p>在这里上传、命名和管理内容，前台会立即同步展示。</p>
        </div>
        <div className="security-note">
          <AlertTriangle size={19} />
          <span>
            当前未设置管理密码，请只部署在个人网络、VPN 或受保护的入口后。
          </span>
        </div>
      </section>
      {corsWarning && (
        <div className="error-banner cors-warning">
          <span>{corsWarning}</span>
          <button onClick={() => setCorsWarning("")}>关闭</button>
        </div>
      )}
      <UploadQueue onUploaded={() => setRefreshKey((key) => key + 1)} />
      <MediaManager refreshKey={refreshKey} />
    </main>
  );
}
