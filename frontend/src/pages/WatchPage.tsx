import {
  ArrowLeft,
  CalendarDays,
  HardDrive,
  LoaderCircle,
  Ratio,
  RotateCw,
} from "lucide-react";
import {
  useCallback,
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

const TARGET_BUFFER_SECONDS = 6;
const MIN_RESUME_BUFFER_SECONDS = 2;
const MAX_BUFFER_HOLD_MS = 5_000;
const RELATED_FALLBACK_MS = 6_000;
const PROCESSING_POLL_MS = 5_000;

type PlaybackPhase =
  | "idle"
  | "preparing"
  | "rebuffering"
  | "playing"
  | "ready"
  | "error";

type HoldReason = "initial" | "rebuffering";

interface NetworkInformationLike {
  saveData?: boolean;
}

interface NavigatorWithConnection extends Navigator {
  connection?: NetworkInformationLike;
}

interface PendingRestore {
  currentTime: number;
  shouldPlay: boolean;
}

function prefersDataSaving(): boolean {
  if (typeof navigator === "undefined") return false;
  return Boolean(
    (navigator as NavigatorWithConnection).connection?.saveData,
  );
}

function getBufferedAhead(video: HTMLVideoElement): number {
  const currentTime = video.currentTime;
  for (let index = 0; index < video.buffered.length; index += 1) {
    const start = video.buffered.start(index);
    const end = video.buffered.end(index);
    if (currentTime + 0.15 >= start && currentTime <= end) {
      return Math.max(0, end - currentTime);
    }
  }
  return 0;
}

function getRemainingSeconds(video: HTMLVideoElement): number {
  if (!Number.isFinite(video.duration)) return TARGET_BUFFER_SECONDS;
  return Math.max(0, video.duration - video.currentTime);
}

function getTargetBuffer(video: HTMLVideoElement): number {
  return Math.min(TARGET_BUFFER_SECONDS, getRemainingSeconds(video));
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
  const [playbackPhase, setPlaybackPhase] =
    useState<PlaybackPhase>("idle");
  const [bufferedAhead, setBufferedAhead] = useState(0);
  const [playbackError, setPlaybackError] = useState("");
  const [retrying, setRetrying] = useState(false);
  const [playerRevision, setPlayerRevision] = useState(0);
  const [conserveData] = useState(prefersDataSaving);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playbackTypeRef = useRef(media?.playback_type ?? "direct");
  playbackTypeRef.current = media?.playback_type ?? "direct";
  const activeIdRef = useRef(id);
  activeIdRef.current = id;
  const holdReasonRef = useRef<HoldReason | null>(null);
  const holdStartedAtRef = useRef(0);
  const holdTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const shouldResumeRef = useRef(false);
  const hasStartedRef = useRef(false);
  const seekingRef = useRef(false);
  const resumeAfterSeekRef = useRef(false);
  const bypassNextPlayRef = useRef(false);
  const skipHoldUntilPlayingRef = useRef(false);
  const relatedLoaderRef = useRef<(() => void) | null>(null);
  const pendingRestoreRef = useRef<PendingRestore | null>(null);

  const clearHoldTimer = useCallback(() => {
    if (holdTimerRef.current !== null) {
      clearInterval(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  }, []);

  const clearHold = useCallback(() => {
    clearHoldTimer();
    holdReasonRef.current = null;
    holdStartedAtRef.current = 0;
    shouldResumeRef.current = false;
  }, [clearHoldTimer]);

  const updateBufferedAhead = useCallback(() => {
    const video = videoRef.current;
    if (!video) return 0;
    const ahead = getBufferedAhead(video);
    setBufferedAhead(ahead);
    return ahead;
  }, []);

  const playWithFallback = useCallback((video: HTMLVideoElement) => {
    bypassNextPlayRef.current = true;
    void video.play().catch((reason: unknown) => {
      bypassNextPlayRef.current = false;
      if (
        video.error ||
        (reason instanceof DOMException && reason.name === "AbortError")
      ) {
        return;
      }
      setPlaybackPhase("ready");
    });
  }, []);

  const evaluateHold = useCallback(() => {
    const video = videoRef.current;
    if (!video || holdReasonRef.current === null) return;

    const ahead = getBufferedAhead(video);
    const remaining = getRemainingSeconds(video);
    const target = getTargetBuffer(video);
    const elapsed = Date.now() - holdStartedAtRef.current;
    const minimumAfterTimeout = Math.min(
      MIN_RESUME_BUFFER_SECONDS,
      remaining,
    );
    setBufferedAhead(ahead);

    const targetReached = ahead + 0.1 >= target;
    const timedOutWithMinimum =
      elapsed >= MAX_BUFFER_HOLD_MS &&
      ahead + 0.1 >= minimumAfterTimeout;
    if (!targetReached && !timedOutWithMinimum) return;

    const shouldResume = shouldResumeRef.current;
    clearHold();
    if (shouldResume) {
      playWithFallback(video);
    } else {
      setPlaybackPhase("ready");
    }
  }, [clearHold, playWithFallback]);

  const beginHold = useCallback(
    (reason: HoldReason, shouldResume: boolean) => {
      const video = videoRef.current;
      if (
        !video ||
        seekingRef.current ||
        playbackTypeRef.current === "hls"
      ) {
        return false;
      }

      const ahead = getBufferedAhead(video);
      setBufferedAhead(ahead);
      if (ahead + 0.1 >= getTargetBuffer(video)) return false;

      clearHoldTimer();
      holdReasonRef.current = reason;
      holdStartedAtRef.current = Date.now();
      shouldResumeRef.current = shouldResume;
      video.pause();
      setPlaybackPhase(
        reason === "initial" ? "preparing" : "rebuffering",
      );
      holdTimerRef.current = setInterval(evaluateHold, 250);
      return true;
    },
    [clearHoldTimer, evaluateHold],
  );

  const resumeImmediately = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    clearHold();
    skipHoldUntilPlayingRef.current = true;
    playWithFallback(video);
  }, [clearHold, playWithFallback]);

  useEffect(() => {
    const controller = new AbortController();
    setMedia(null);
    setDetailError("");
    setPlaybackError("");
    setPlaybackPhase("idle");
    setBufferedAhead(0);
    setRetrying(false);
    setPlayerRevision((current) => current + 1);
    hasStartedRef.current = false;
    seekingRef.current = false;
    resumeAfterSeekRef.current = false;
    bypassNextPlayRef.current = false;
    skipHoldUntilPlayingRef.current = false;
    pendingRestoreRef.current = null;
    clearHold();

    getMedia(id, { signal: controller.signal })
      .then((detail) => setMedia(detail))
      .catch((reason: unknown) => {
        if (!isAbortError(reason)) {
          setDetailError(errorMessage(reason, "视频详情加载失败"));
        }
      });

    return () => {
      controller.abort();
      clearHold();
    };
  }, [clearHold, id]);

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

    setPlaybackError("");
    setPlaybackPhase("idle");
    if (media.playback_type === "direct") {
      video.load();
      return;
    }

    clearHold();
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
          setPlaybackError("当前浏览器不支持 HLS 自适应视频播放。");
          setPlaybackPhase("error");
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
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal || cancelled) return;
          setPlaybackError(
            "自适应视频流加载中断，请重新加载后继续观看。",
          );
          setPlaybackPhase("error");
        });
        hls.attachMedia(video);
      })
      .catch(() => {
        if (cancelled) return;
        setPlaybackError("自适应播放器加载失败，请刷新页面重试。");
        setPlaybackPhase("error");
      });
    return () => {
      cancelled = true;
      activeHls?.destroy();
      video.removeAttribute("src");
      video.load();
    };
  }, [
    clearHold,
    conserveData,
    media,
    playerRevision,
  ]);

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

  useEffect(
    () => () => {
      clearHold();
    },
    [clearHold],
  );

  const handlePlay = () => {
    const video = videoRef.current;
    if (!video) return;

    if (bypassNextPlayRef.current) {
      bypassNextPlayRef.current = false;
      hasStartedRef.current = true;
      setPlaybackPhase("playing");
      return;
    }
    if (holdReasonRef.current !== null) {
      video.pause();
      return;
    }

    if (!hasStartedRef.current) {
      hasStartedRef.current = true;
      if (beginHold("initial", true)) return;
    }
    setPlaybackPhase("playing");
  };

  const handleWaiting = () => {
    const video = videoRef.current;
    if (!video) return;
    updateBufferedAhead();

    if (seekingRef.current || skipHoldUntilPlayingRef.current) {
      setPlaybackPhase("rebuffering");
      return;
    }
    if (hasStartedRef.current && holdReasonRef.current === null) {
      if (!beginHold("rebuffering", true)) {
        setPlaybackPhase("rebuffering");
      }
    } else {
      setPlaybackPhase("preparing");
    }
  };

  const handleStalled = () => {
    const video = videoRef.current;
    if (!video || video.paused) return;
    handleWaiting();
  };

  const handlePlaying = () => {
    clearHold();
    hasStartedRef.current = true;
    skipHoldUntilPlayingRef.current = false;
    setPlaybackError("");
    setPlaybackPhase("playing");
    updateBufferedAhead();
  };

  const handleCanPlay = () => {
    relatedLoaderRef.current?.();
    updateBufferedAhead();
    if (holdReasonRef.current !== null) evaluateHold();
  };

  const handleSeeking = () => {
    const video = videoRef.current;
    if (!video) return;
    resumeAfterSeekRef.current =
      shouldResumeRef.current || (!video.paused && hasStartedRef.current);
    seekingRef.current = true;
    clearHold();
    setPlaybackPhase("rebuffering");
  };

  const handleSeeked = () => {
    const video = videoRef.current;
    if (!video) return;
    seekingRef.current = false;
    updateBufferedAhead();

    const pendingRestore = pendingRestoreRef.current;
    if (pendingRestore) {
      pendingRestoreRef.current = null;
      if (pendingRestore.shouldPlay) playWithFallback(video);
      return;
    }
    if (resumeAfterSeekRef.current && video.paused) {
      resumeAfterSeekRef.current = false;
      playWithFallback(video);
    }
  };

  const handleLoadedMetadata = () => {
    const video = videoRef.current;
    if (!video) return;
    updateBufferedAhead();

    const pendingRestore = pendingRestoreRef.current;
    if (!pendingRestore) return;
    const maximum = Number.isFinite(video.duration)
      ? Math.max(0, video.duration - 0.1)
      : pendingRestore.currentTime;
    const nextTime = Math.min(pendingRestore.currentTime, maximum);
    if (nextTime > 0.05) {
      video.currentTime = nextTime;
    } else {
      pendingRestoreRef.current = null;
      if (pendingRestore.shouldPlay) playWithFallback(video);
    }
  };

  const handleMediaError = () => {
    relatedLoaderRef.current?.();
    clearHold();
    setPlaybackError("视频加载中断，请重新加载后继续观看。");
    setPlaybackPhase("error");
  };

  const handleRetry = async () => {
    const retryId = id;
    const currentVideo = videoRef.current;
    const restore: PendingRestore = {
      currentTime: currentVideo?.currentTime ?? 0,
      shouldPlay: hasStartedRef.current,
    };
    setRetrying(true);
    setPlaybackError("");
    try {
      const freshMedia = await getMedia(retryId, { fresh: true });
      if (activeIdRef.current !== retryId) return;
      pendingRestoreRef.current = restore;
      setMedia(freshMedia);
      setPlayerRevision((current) => current + 1);
      setPlaybackPhase("preparing");
    } catch (reason) {
      if (activeIdRef.current !== retryId) return;
      setPlaybackError(
        errorMessage(reason, "重新获取视频地址失败，请稍后再试。"),
      );
      setPlaybackPhase("error");
    } finally {
      if (activeIdRef.current === retryId) setRetrying(false);
    }
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
        <LoaderCircle className="buffer-spinner" size={32} />
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

  const showBufferOverlay = playbackPhase === "preparing" ||
    playbackPhase === "rebuffering" ||
    playbackPhase === "ready" ||
    playbackPhase === "error";
  const bufferLabel = playbackPhase === "ready"
    ? "缓冲已准备好"
    : playbackPhase === "rebuffering"
      ? "网络有些慢，正在多缓冲一点…"
      : "正在提前缓冲…";

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
              key={`${media.content_url}-${playerRevision}`}
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
              onError={handleMediaError}
              onLoadedMetadata={handleLoadedMetadata}
              onPlay={handlePlay}
              onPlaying={handlePlaying}
              onProgress={() => {
                updateBufferedAhead();
                evaluateHold();
              }}
              onSeeked={handleSeeked}
              onSeeking={handleSeeking}
              onStalled={handleStalled}
              onTimeUpdate={updateBufferedAhead}
              onWaiting={handleWaiting}
            >
              当前浏览器无法播放该视频。
            </video>
            {showBufferOverlay && (
              <div className="buffer-overlay" role="status" aria-live="polite">
                <div className="buffer-card">
                  {playbackPhase === "error" ? (
                    <RotateCw size={24} />
                  ) : (
                    <LoaderCircle className="buffer-spinner" size={26} />
                  )}
                  <strong>
                    {playbackPhase === "error"
                      ? "播放暂时中断"
                      : bufferLabel}
                  </strong>
                  <span>
                    {playbackPhase === "error"
                      ? playbackError
                      : `已准备 ${Math.floor(bufferedAhead)} 秒`}
                  </span>
                  {playbackPhase === "error" ? (
                    <button
                      type="button"
                      className="buffer-action"
                      onClick={handleRetry}
                      disabled={retrying}
                    >
                      {retrying ? "正在重新加载…" : "重新加载"}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="buffer-action"
                      onClick={resumeImmediately}
                    >
                      立即播放
                    </button>
                  )}
                </div>
              </div>
            )}
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
                : "播放页会提前缓冲一部分内容；实际加载量由浏览器和网络决定。"}
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
