import { ChevronLeft, ChevronRight, Images, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { getMedia, listMedia } from "../api";
import { EmptyState } from "../components/EmptyState";
import { MediaCard } from "../components/MediaCard";
import { PageLoader } from "../components/PageLoader";
import type { MediaCardData, MediaDetailData } from "../types";

interface LightboxProps {
  items: MediaCardData[];
  index: number;
  onChange: (index: number) => void;
  onClose: () => void;
}

function Lightbox({ items, index, onChange, onClose }: LightboxProps) {
  const [detail, setDetail] = useState<MediaDetailData | null>(null);
  const [error, setError] = useState("");
  const current = items[index];

  const previous = useCallback(
    () => onChange((index - 1 + items.length) % items.length),
    [index, items.length, onChange],
  );
  const next = useCallback(
    () => onChange((index + 1) % items.length),
    [index, items.length, onChange],
  );

  useEffect(() => {
    setDetail(null);
    setError("");
    getMedia(current.id)
      .then(setDetail)
      .catch((reason: Error) => setError(reason.message));
  }, [current.id]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowLeft") previous();
      if (event.key === "ArrowRight") next();
    };
    document.body.classList.add("lightbox-open");
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.classList.remove("lightbox-open");
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [next, onClose, previous]);

  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={current.title}>
      <button className="lightbox-close" onClick={onClose} aria-label="关闭">
        <X size={24} />
      </button>
      {items.length > 1 && (
        <>
          <button className="lightbox-prev" onClick={previous} aria-label="上一张">
            <ChevronLeft size={30} />
          </button>
          <button className="lightbox-next" onClick={next} aria-label="下一张">
            <ChevronRight size={30} />
          </button>
        </>
      )}
      <div className="lightbox-content">
        {error ? (
          <div className="lightbox-error">{error}</div>
        ) : detail ? (
          <img src={detail.content_url} alt={detail.title} />
        ) : (
          <PageLoader label="正在打开原图…" />
        )}
      </div>
      <div className="lightbox-caption">
        <strong>{current.title}</strong>
        <span>
          {index + 1} / {items.length}
        </span>
      </div>
    </div>
  );
}

export function PhotoLibrary() {
  const [searchParams] = useSearchParams();
  const query = searchParams.get("q") ?? "";
  const [items, setItems] = useState<MediaCardData[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    listMedia("photo", query, 1, 100)
      .then((result) => {
        if (cancelled) return;
        setItems(result.items);
        setTotal(result.total);
      })
      .catch((reason: Error) => !cancelled && setError(reason.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [query]);

  return (
    <main className="page-shell">
      <section className="hero photo-hero">
        <div>
          <span className="eyebrow">
            <Images size={15} />
            私人照片墙
          </span>
          <h1>{query ? `“${query}”的搜索结果` : "让照片替你记住当时的光"}</h1>
          <p>轻点一张照片进入沉浸浏览，原图只在打开时加载。</p>
        </div>
        <div className="hero-stat">
          <strong>{total}</strong>
          <span>张照片</span>
        </div>
      </section>

      {error && <div className="error-banner">{error}</div>}
      {loading ? (
        <PageLoader />
      ) : items.length === 0 ? (
        <EmptyState searching={Boolean(query)} type="照片" />
      ) : (
        <>
          <div className="section-heading">
            <div>
              <h2>{query ? "搜索结果" : "全部照片"}</h2>
              <p>点击查看原始画质</p>
            </div>
          </div>
          <div className="photo-grid">
            {items.map((media, index) => (
              <MediaCard
                key={media.id}
                media={media}
                photo
                onPhotoClick={() => setActiveIndex(index)}
              />
            ))}
          </div>
        </>
      )}

      {activeIndex !== null && (
        <Lightbox
          items={items}
          index={activeIndex}
          onChange={setActiveIndex}
          onClose={() => setActiveIndex(null)}
        />
      )}
    </main>
  );
}
