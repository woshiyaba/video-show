import { ArrowLeft, CalendarDays, HardDrive, Ratio } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getMedia, listMedia } from "../api";
import { MediaCard } from "../components/MediaCard";
import { PageLoader } from "../components/PageLoader";
import { formatBytes, formatDate } from "../media-utils";
import type { MediaCardData, MediaDetailData } from "../types";

export function WatchPage() {
  const { id = "" } = useParams();
  const [media, setMedia] = useState<MediaDetailData | null>(null);
  const [related, setRelated] = useState<MediaCardData[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setMedia(null);
    setError("");
    Promise.all([getMedia(id), listMedia("video", "", 1, 8)])
      .then(([detail, list]) => {
        if (cancelled) return;
        setMedia(detail);
        setRelated(list.items.filter((item) => item.id !== id).slice(0, 6));
      })
      .catch((reason: Error) => !cancelled && setError(reason.message));
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) {
    return (
      <main className="page-shell narrow-message">
        <h1>无法打开这段视频</h1>
        <p>{error}</p>
        <Link to="/" className="primary-button">
          返回视频库
        </Link>
      </main>
    );
  }
  if (!media) return <PageLoader label="正在准备播放…" />;

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
              key={media.content_url}
              src={media.content_url}
              poster={media.thumbnail_url ?? undefined}
              controls
              playsInline
              preload="metadata"
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
                {formatBytes(media.size_bytes)}
              </span>
              {media.width && media.height && (
                <span>
                  <Ratio size={15} />
                  {media.width} × {media.height}
                </span>
              )}
            </div>
            <p className="stream-note">
              此视频按播放进度从 COS 分段读取，不会在打开页面时下载完整文件。
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
