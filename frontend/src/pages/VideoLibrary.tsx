import { Film, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { listMedia } from "../api";
import { EmptyState } from "../components/EmptyState";
import { MediaCard } from "../components/MediaCard";
import { PageLoader } from "../components/PageLoader";
import type { MediaCardData } from "../types";

export function VideoLibrary() {
  const [searchParams] = useSearchParams();
  const query = searchParams.get("q") ?? "";
  const [items, setItems] = useState<MediaCardData[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setPage(1);
    setError("");
    listMedia("video", query, 1)
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
  }, [query, reloadKey]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const nextPage = page + 1;
      const result = await listMedia("video", query, nextPage);
      setItems((current) => [...current, ...result.items]);
      setPage(nextPage);
      setTotal(result.total);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "加载失败");
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <main className="page-shell">
      <section className="hero">
        <div>
          <span className="eyebrow">
            <Film size={15} />
            私人放映室
          </span>
          <h1>{query ? `“${query}”的搜索结果` : "收藏每一段值得重温的画面"}</h1>
          <p>
            视频从云端按需加载，停留在此刻，也随时回到故事发生的地方。
          </p>
        </div>
        <div className="hero-stat">
          <strong>{total}</strong>
          <span>段视频</span>
        </div>
      </section>

      {error && (
        <div className="error-banner">
          <span>{error}</span>
          <button onClick={() => setReloadKey((key) => key + 1)}>
            <RefreshCw size={16} />
            重试
          </button>
        </div>
      )}

      {loading ? (
        <PageLoader />
      ) : items.length === 0 ? (
        <EmptyState searching={Boolean(query)} type="视频" />
      ) : (
        <>
          <div className="section-heading">
            <div>
              <h2>{query ? "搜索结果" : "最近上传"}</h2>
              <p>按上传时间由新到旧排列</p>
            </div>
          </div>
          <div className="video-grid">
            {items.map((media) => (
              <MediaCard key={media.id} media={media} />
            ))}
          </div>
          {items.length < total && (
            <div className="load-more-wrap">
              <button
                className="secondary-button"
                onClick={loadMore}
                disabled={loadingMore}
              >
                {loadingMore ? "正在加载…" : "加载更多"}
              </button>
            </div>
          )}
        </>
      )}
    </main>
  );
}
