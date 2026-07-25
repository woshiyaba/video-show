import {
  ArrowLeft,
  CalendarDays,
  HardDrive,
  LoaderCircle,
  Ratio,
  RotateCw,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
} from "react";
import { Link, useParams } from "react-router-dom";
import { getMedia, listMedia } from "../api";
import { MediaCard } from "../components/MediaCard";
import { PageLoader } from "../components/PageLoader";
import { formatBytes, formatDate } from "../media-utils";
import type { MediaCardData, MediaDetailData } from "../types";

const RELATED_FALLBACK_MS = 6_000;
const PROCESSING_POLL_MS = 5_000;

interface NetworkInformationLike {
  saveData?: boolean;
}

interface NavigatorWithConnection extends Navigator {
  connection?: NetworkInformationLike;
}

function prefersDataSaving(): boolean {
  if (typeof navigator === "undefined") return false;
  return Boolean(
    (navigator as NavigatorWithConnection).connection?.saveData,
  );
}

function isAbortError(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === "AbortError";
}

function errorMessage(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}

export function WatchPage() {
  const { id = "" } = useParams();
  const [media, setMedia] = useState<MediaDetailData | null>(null);
  const [related, setRelated] = useState<MediaCardData[]>([]);
  const [detailError, setDetailError] = useState("");
  const [relatedError, setRelatedError] = useState("");
  const [relatedLoading, setRelatedLoading] = useState(false);
  const [conserveData] = useState(prefersDataSaving);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const relatedLoaderRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setMedia(null);
    setDetailError("");

    getMedia(id, { signal: controller.signal })
      .then((detail) => setMedia(detail))
      .catch((reason: unknown) => {
        if (!isAbortError(reason)) {
          setDetailError(errorMessage(reason, "视频详情加载失败"));
        }
      });

    return () => {
      controller.abort();
    };
  }, [id]);

  useEffect(() => {
    if (
      !media ||
      media.processing_status !== "ready" ||
      !media.content_url
    ) {
      return;
    }
    const video = videoRef.current;
    if (!video) return;

    if (media.playback_type === "direct") {
      video.load();
      return;
    }

    const source = media.content_url;
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = source;
      video.load();
      return () => {
        video.removeAttribute("src");
        video.load();
      };
    }
    let cancelled = false;
    let activeHls: { destroy: () => void } | null = null;
    void import("hls.js")
      .then(({ default: Hls }) => {
        if (cancelled) return;
        if (!Hls.isSupported()) {
          video.src = source;
          video.load();
          return;
        }

        const hls = new Hls({
          startLevel: -1,
          maxBufferLength: conserveData ? 12 : 30,
          backBufferLength: 30,
        });
        activeHls = hls;
        hls.on(Hls.Events.MEDIA_ATTACHED, () => {
          hls.loadSource(source);
        });
        hls.attachMedia(video);
      })
      .catch(() => {
        if (cancelled) return;
        video.src = source;
        video.load();
      });
    return () => {
      cancelled = true;
      activeHls?.destroy();
      video.removeAttribute("src");
      video.load();
    };
  }, [conserveData, media]);

  useEffect(() => {
    if (media?.processing_status !== "processing") return;

    let cancelled = false;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = () => {
      controller = new AbortController();
      getMedia(id, { fresh: true, signal: controller.signal })
        .then((detail) => {
          if (cancelled) return;
          setMedia(detail);
          if (detail.processing_status === "processing") {
            timer = setTimeout(poll, PROCESSING_POLL_MS);
          }
        })
        .catch((reason: unknown) => {
          if (cancelled || isAbortError(reason)) return;
          timer = setTimeout(poll, PROCESSING_POLL_MS);
        });
    };
    timer = setTimeout(poll, PROCESSING_POLL_MS);
    return () => {
      cancelled = true;
      controller?.abort();
      if (timer !== null) clearTimeout(timer);
    };
  }, [id, media?.processing_status]);

  useEffect(() => {
    if (!media || media.processing_status !== "ready") return;

    const controller = new AbortController();
    let started = false;
    setRelated([]);
    setRelatedError("");
    setRelatedLoading(false);

    const loadRelated = () => {
      if (started) return;
      started = true;
      setRelatedLoading(true);
      listMedia("video", "", 1, 8, { signal: controller.signal })
        .then((list) => {
          setRelated(
            list.items.filter((item) => item.id !== id).slice(0, 6),
          );
        })
        .catch((reason: unknown) => {
          if (!isAbortError(reason)) {
            setRelatedError(
              errorMessage(reason, "相关推荐暂时加载失败"),
            );
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setRelatedLoading(false);
        });
    };

    relatedLoaderRef.current = loadRelated;
    const fallbackTimer = setTimeout(loadRelated, RELATED_FALLBACK_MS);
    return () => {
      relatedLoaderRef.current = null;
      clearTimeout(fallbackTimer);
      controller.abort();
    };
  }, [id, media]);

  const handleCanPlay = () => {
    relatedLoaderRef.current?.();
  };

  if (detailError) {
    return (
      <main className="page-shell narrow-message">
        <h1>无法打开这段视频</h1>
        <p>{detailError}</p>
        <Link to="/" className="primary-button">
          返回视频库
        </Link>
      </main>
    );
  }
  if (!media) return <PageLoader label="正在准备播放…" />;
  if (media.processing_status === "processing") {
    return (
      <main className="page-shell narrow-message processing-message">
        <LoaderCircle className="processing-spinner" size={32} />
        <span className="eyebrow">腾讯云数据万象</span>
        <h1>视频正在云端压缩</h1>
        <p>
          “{media.title}”正在生成 1080p 和 720p 自适应播放版，
          完成后此页面会自动开始准备播放。
        </p>
        <p className="processing-note" role="status" aria-live="polite">
          可以暂时离开此页面，稍后再回来查看。
        </p>
        <Link to="/" className="primary-button">
          返回视频库
        </Link>
      </main>
    );
  }
  if (media.processing_status === "failed") {
    return (
      <main className="page-shell narrow-message processing-message failed">
        <RotateCw size={32} />
        <span className="eyebrow">原片已安全保留</span>
        <h1>视频压缩失败</h1>
        <p>
          {media.processing_error ??
            "腾讯云没有成功生成播放版，请在数据万象控制台查看任务详情。"}
        </p>
        <Link to="/" className="primary-button">
          返回视频库
        </Link>
      </main>
    );
  }
  if (!media.content_url) {
    return (
      <main className="page-shell narrow-message">
        <h1>播放地址尚未准备好</h1>
        <p>请稍后刷新页面重试。</p>
        <Link to="/" className="primary-button">
          返回视频库
        </Link>
      </main>
    );
  }

  return (
    <main className="watch-shell">
      <Link to="/" className="back-link">
        <ArrowLeft size={18} />
        返回视频库
      </Link>
      <div className="watch-layout">
        <section>
          <div className="player-frame">
            <video
              ref={videoRef}
              src={
                media.playback_type === "direct"
                  ? media.content_url
                  : undefined
              }
              poster={media.thumbnail_url ?? undefined}
              controls
              playsInline
              preload={conserveData ? "metadata" : "auto"}
              onCanPlay={handleCanPlay}
            >
              当前浏览器无法播放该视频。
            </video>
          </div>
          <div className="watch-info">
            <span className="eyebrow">正在播放</span>
            <h1>{media.title}</h1>
            <div className="detail-pills">
              <span>
                <CalendarDays size={15} />
                {formatDate(media.created_at)}
              </span>
              <span>
                <HardDrive size={15} />
                {formatBytes(
                  media.playback_size_bytes ?? media.size_bytes,
                )}
              </span>
              {media.width && media.height && (
                <span>
                  <Ratio size={15} />
                  {media.width} × {media.height}
                </span>
              )}
            </div>
            <p className="stream-note">
              {media.playback_type === "hls"
                ? "播放器会根据当前网络在 1080p 与 720p 之间自动切换。"
                : "视频由浏览器原生播放器直接加载。"}
            </p>
          </div>
        </section>

        <aside className="related-panel">
          <div className="section-heading compact">
            <div>
              <h2>接着观看</h2>
              <p>最近添加的视频</p>
            </div>
          </div>
          {relatedLoading && related.length === 0 && (
            <p className="related-status">正在加载推荐…</p>
          )}
          {relatedError && related.length === 0 && (
            <p className="related-status">{relatedError}</p>
          )}
          <div className="related-list">
            {related.map((item) => (
              <MediaCard key={item.id} media={item} />
            ))}
          </div>
        </aside>
      </div>
    </main>
  );
}
