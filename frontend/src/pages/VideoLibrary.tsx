import { Film, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { listMedia } from "../api";
import { EmptyState } from "../components/EmptyState";
import { MediaCard } from "../components/MediaCard";
import { PageLoader } from "../components/PageLoader";
import type { MediaCardData, MediaListData } from "../types";

const PAGE_SIZE = 24;
const AUTO_LOAD_MARGIN_PX = 600;

interface NetworkInformationLike {
  effectiveType?: string;
  saveData?: boolean;
  addEventListener?: (type: "change", listener: EventListener) => void;
  removeEventListener?: (type: "change", listener: EventListener) => void;
}

interface LibrarySession {
  cancelled: boolean;
  query: string;
  loadedPage: number;
  total: number;
  exhausted: boolean;
  itemIds: Set<string>;
  activeController: AbortController | null;
  requestTail: Promise<void>;
  pageRequests: Map<number, Promise<MediaListData>>;
  pageResults: Map<number, MediaListData>;
  appendPromise: Promise<void> | null;
}

interface ScheduledIdleWork {
  kind: "idle" | "timeout";
  id: number;
}

type WindowWithIdleCallback = Window &
  typeof globalThis & {
    requestIdleCallback?: (
      callback: () => void,
      options?: { timeout: number },
    ) => number;
    cancelIdleCallback?: (id: number) => void;
  };

function abortError() {
  const error = new Error("请求已取消");
  error.name = "AbortError";
  return error;
}

function isAbortError(reason: unknown) {
  return reason instanceof Error && reason.name === "AbortError";
}

function getConnection() {
  return (
    navigator as Navigator & {
      connection?: NetworkInformationLike;
    }
  ).connection;
}

function canPrefetch() {
  if (document.visibilityState !== "visible") return false;

  const connection = getConnection();
  if (!connection) return true;
  if (connection.saveData) return false;
  const effectiveType = connection.effectiveType?.toLowerCase();
  return effectiveType !== "slow-2g" && effectiveType !== "2g";
}

function hasNextPage(session: LibrarySession) {
  return (
    !session.exhausted &&
    session.loadedPage * PAGE_SIZE < session.total &&
    session.itemIds.size < session.total
  );
}

function createSession(query: string): LibrarySession {
  return {
    cancelled: false,
    query,
    loadedPage: 0,
    total: 0,
    exhausted: false,
    itemIds: new Set(),
    activeController: null,
    requestTail: Promise.resolve(),
    pageRequests: new Map(),
    pageResults: new Map(),
    appendPromise: null,
  };
}

function cancelSession(session: LibrarySession) {
  session.cancelled = true;
  session.activeController?.abort();
  session.activeController = null;
}

function requestPage(session: LibrarySession, page: number) {
  const cached = session.pageResults.get(page);
  if (cached) return Promise.resolve(cached);

  const existing = session.pageRequests.get(page);
  if (existing) return existing;

  const previousRequest = session.requestTail;
  const request = previousRequest
    .catch(() => undefined)
    .then(async () => {
      if (session.cancelled) throw abortError();

      const controller = new AbortController();
      session.activeController = controller;
      try {
        const result = await listMedia(
          "video",
          session.query,
          page,
          PAGE_SIZE,
          { signal: controller.signal },
        );
        if (session.cancelled) throw abortError();
        session.pageResults.set(page, result);
        return result;
      } finally {
        if (session.activeController === controller) {
          session.activeController = null;
        }
      }
    });

  session.pageRequests.set(page, request);
  session.requestTail = request.then(
    () => undefined,
    () => undefined,
  );
  request.then(
    () => session.pageRequests.delete(page),
    () => session.pageRequests.delete(page),
  );
  return request;
}

function scheduleIdleWork(callback: () => void): ScheduledIdleWork {
  const idleWindow = window as WindowWithIdleCallback;
  if (idleWindow.requestIdleCallback) {
    return {
      kind: "idle",
      id: idleWindow.requestIdleCallback(callback, { timeout: 1_500 }),
    };
  }
  return {
    kind: "timeout",
    id: window.setTimeout(callback, 300),
  };
}

function cancelIdleWork(work: ScheduledIdleWork) {
  const idleWindow = window as WindowWithIdleCallback;
  if (work.kind === "idle" && idleWindow.cancelIdleCallback) {
    idleWindow.cancelIdleCallback(work.id);
  } else {
    window.clearTimeout(work.id);
  }
}

export function VideoLibrary() {
  const [searchParams] = useSearchParams();
  const query = searchParams.get("q") ?? "";
  const [items, setItems] = useState<MediaCardData[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const sessionRef = useRef<LibrarySession | null>(null);
  const scheduledPrefetchRef = useRef<ScheduledIdleWork | null>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);
  const autoLoadArmedRef = useRef(true);

  const cancelScheduledPrefetch = useCallback(() => {
    if (!scheduledPrefetchRef.current) return;
    cancelIdleWork(scheduledPrefetchRef.current);
    scheduledPrefetchRef.current = null;
  }, []);

  const prefetchNextPage = useCallback((session: LibrarySession) => {
    if (
      sessionRef.current !== session ||
      session.cancelled ||
      !hasNextPage(session) ||
      !canPrefetch()
    ) {
      return;
    }

    const nextPage = session.loadedPage + 1;
    void requestPage(session, nextPage).catch(() => {
      // Prefetching is best-effort. A visible load-more action can retry later.
    });
  }, []);

  const scheduleNextPagePrefetch = useCallback(
    (session: LibrarySession) => {
      cancelScheduledPrefetch();
      if (
        sessionRef.current !== session ||
        session.cancelled ||
        !hasNextPage(session) ||
        !canPrefetch()
      ) {
        return;
      }

      scheduledPrefetchRef.current = scheduleIdleWork(() => {
        scheduledPrefetchRef.current = null;
        prefetchNextPage(session);
      });
    },
    [cancelScheduledPrefetch, prefetchNextPage],
  );

  useEffect(() => {
    cancelScheduledPrefetch();
    if (sessionRef.current) cancelSession(sessionRef.current);

    const session = createSession(query);
    sessionRef.current = session;
    autoLoadArmedRef.current = true;
    setLoading(true);
    setLoadingMore(false);
    setItems([]);
    setTotal(0);
    setHasMore(false);
    setError("");

    requestPage(session, 1)
      .then((result) => {
        if (sessionRef.current !== session || session.cancelled) return;

        const uniqueItems = result.items.filter((item) => {
          if (session.itemIds.has(item.id)) return false;
          session.itemIds.add(item.id);
          return true;
        });
        session.loadedPage = 1;
        session.total = result.total;
        session.exhausted = result.items.length < PAGE_SIZE;

        setItems(uniqueItems);
        setTotal(result.total);
        setHasMore(hasNextPage(session));
        scheduleNextPagePrefetch(session);
      })
      .catch((reason: unknown) => {
        if (
          sessionRef.current === session &&
          !session.cancelled &&
          !isAbortError(reason)
        ) {
          setError(reason instanceof Error ? reason.message : "加载失败");
        }
      })
      .finally(() => {
        if (sessionRef.current === session && !session.cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelSession(session);
      cancelScheduledPrefetch();
    };
  }, [cancelScheduledPrefetch, query, reloadKey, scheduleNextPagePrefetch]);

  const loadMore = useCallback(() => {
    const session = sessionRef.current;
    if (!session || session.cancelled || !hasNextPage(session)) {
      return Promise.resolve();
    }
    if (session.appendPromise) return session.appendPromise;

    const append = (async () => {
      setLoadingMore(true);
      setError("");
      try {
        const nextPage = session.loadedPage + 1;
        const result = await requestPage(session, nextPage);
        if (sessionRef.current !== session || session.cancelled) return;

        const additions = result.items.filter((item) => {
          if (session.itemIds.has(item.id)) return false;
          session.itemIds.add(item.id);
          return true;
        });
        session.loadedPage = nextPage;
        session.total = result.total;
        session.exhausted =
          result.items.length < PAGE_SIZE ||
          session.loadedPage * PAGE_SIZE >= result.total;

        setItems((current) => [...current, ...additions]);
        setTotal(result.total);
        setHasMore(hasNextPage(session));
        scheduleNextPagePrefetch(session);
      } catch (reason) {
        if (
          sessionRef.current === session &&
          !session.cancelled &&
          !isAbortError(reason)
        ) {
          setError(reason instanceof Error ? reason.message : "加载失败");
        }
      } finally {
        if (sessionRef.current === session && !session.cancelled) {
          setLoadingMore(false);
        }
      }
    })();

    session.appendPromise = append;
    append.then(
      () => {
        if (session.appendPromise === append) session.appendPromise = null;
      },
      () => {
        if (session.appendPromise === append) session.appendPromise = null;
      },
    );
    return append;
  }, [scheduleNextPagePrefetch]);

  useEffect(() => {
    const onConnectionOrVisibilityChange = () => {
      const session = sessionRef.current;
      if (!session) return;
      if (canPrefetch()) {
        scheduleNextPagePrefetch(session);
      } else {
        cancelScheduledPrefetch();
      }
    };
    const connection = getConnection();

    document.addEventListener("visibilitychange", onConnectionOrVisibilityChange);
    connection?.addEventListener?.("change", onConnectionOrVisibilityChange);
    return () => {
      document.removeEventListener(
        "visibilitychange",
        onConnectionOrVisibilityChange,
      );
      connection?.removeEventListener?.(
        "change",
        onConnectionOrVisibilityChange,
      );
    };
  }, [cancelScheduledPrefetch, scheduleNextPagePrefetch]);

  useEffect(() => {
    const sentinel = loadMoreSentinelRef.current;
    if (!sentinel || loading || !hasMore) return;

    if (typeof IntersectionObserver !== "undefined") {
      const observer = new IntersectionObserver(
        (entries) => {
          const entry = entries[entries.length - 1];
          if (!entry?.isIntersecting) {
            autoLoadArmedRef.current = true;
          } else if (autoLoadArmedRef.current) {
            autoLoadArmedRef.current = false;
            void loadMore();
          }
        },
        { rootMargin: `${AUTO_LOAD_MARGIN_PX}px 0px` },
      );
      observer.observe(sentinel);
      return () => observer.disconnect();
    }

    const checkDistanceToBottom = () => {
      const isNearBottom =
        sentinel.getBoundingClientRect().top <=
        window.innerHeight + AUTO_LOAD_MARGIN_PX;
      if (!isNearBottom) {
        autoLoadArmedRef.current = true;
      } else if (autoLoadArmedRef.current) {
        autoLoadArmedRef.current = false;
        void loadMore();
      }
    };
    const initialCheck = window.setTimeout(checkDistanceToBottom, 0);
    window.addEventListener("scroll", checkDistanceToBottom, { passive: true });
    window.addEventListener("resize", checkDistanceToBottom);
    return () => {
      window.clearTimeout(initialCheck);
      window.removeEventListener("scroll", checkDistanceToBottom);
      window.removeEventListener("resize", checkDistanceToBottom);
    };
  }, [hasMore, items.length, loadMore, loading]);

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
          {hasMore && (
            <div className="load-more-wrap" ref={loadMoreSentinelRef}>
              <button
                className="secondary-button"
                onClick={() => void loadMore()}
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
