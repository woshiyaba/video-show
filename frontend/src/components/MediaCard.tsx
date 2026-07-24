import { Image as ImageIcon, Play } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { prefetchMedia } from "../api";
import { formatDate, formatDuration } from "../media-utils";
import type { MediaCardData } from "../types";

interface Props {
  media: MediaCardData;
  photo?: boolean;
  onPhotoClick?: () => void;
}

export function MediaCard({ media, photo = false, onPhotoClick }: Props) {
  const prefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearPrefetchTimer = useCallback(() => {
    if (prefetchTimerRef.current === null) return;
    clearTimeout(prefetchTimerRef.current);
    prefetchTimerRef.current = null;
  }, []);
  const runPrefetch = useCallback(() => {
    clearPrefetchTimer();
    void prefetchMedia(media.id);
  }, [clearPrefetchTimer, media.id]);
  const schedulePrefetch = useCallback(() => {
    clearPrefetchTimer();
    prefetchTimerRef.current = setTimeout(runPrefetch, 150);
  }, [clearPrefetchTimer, runPrefetch]);

  useEffect(() => clearPrefetchTimer, [clearPrefetchTimer]);

  const intentHandlers = {
    onPointerEnter: schedulePrefetch,
    onPointerLeave: clearPrefetchTimer,
    onFocus: runPrefetch,
    onPointerDown: runPrefetch,
  };

  const visual = media.thumbnail_url ? (
    <img src={media.thumbnail_url} alt="" loading="lazy" />
  ) : (
    <span className="media-placeholder">
      {photo ? <ImageIcon size={30} /> : <Play size={30} />}
    </span>
  );

  if (photo) {
    return (
      <button
        className="photo-card"
        onClick={onPhotoClick}
        type="button"
        {...intentHandlers}
      >
        <span className="photo-visual">{visual}</span>
        <span className="photo-caption">
          <strong>{media.title}</strong>
          <small>{formatDate(media.created_at)}</small>
        </span>
      </button>
    );
  }

  return (
    <Link
      to={`/watch/${media.id}`}
      className="video-card"
      {...intentHandlers}
    >
      <span className="video-thumbnail">
        {visual}
        {media.duration_seconds != null && (
          <span className="duration-badge">
            {formatDuration(media.duration_seconds)}
          </span>
        )}
        <span className="play-overlay">
          <Play size={24} fill="currentColor" />
        </span>
      </span>
      <span className="video-card-body">
        <span className="video-card-title">{media.title}</span>
        <span className="video-card-meta">
          {formatDate(media.created_at)}
          <span aria-hidden="true">·</span>
          {media.width && media.height
            ? `${media.width} × ${media.height}`
            : "视频"}
        </span>
      </span>
    </Link>
  );
}
