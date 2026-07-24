import { Image as ImageIcon, Play } from "lucide-react";
import { Link } from "react-router-dom";
import { formatDate, formatDuration } from "../media-utils";
import type { MediaCardData } from "../types";

interface Props {
  media: MediaCardData;
  photo?: boolean;
  onPhotoClick?: () => void;
}

export function MediaCard({ media, photo = false, onPhotoClick }: Props) {
  const visual = media.thumbnail_url ? (
    <img src={media.thumbnail_url} alt="" loading="lazy" />
  ) : (
    <span className="media-placeholder">
      {photo ? <ImageIcon size={30} /> : <Play size={30} />}
    </span>
  );

  if (photo) {
    return (
      <button className="photo-card" onClick={onPhotoClick} type="button">
        <span className="photo-visual">{visual}</span>
        <span className="photo-caption">
          <strong>{media.title}</strong>
          <small>{formatDate(media.created_at)}</small>
        </span>
      </button>
    );
  }

  return (
    <Link to={`/watch/${media.id}`} className="video-card">
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
