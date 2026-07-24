import type {
  MediaCardData,
  MediaDetailData,
  MediaListData,
  MediaType,
} from "./types";

const API_ORIGIN = (import.meta.env.VITE_API_ORIGIN ?? "").replace(/\/$/, "");
const APP_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const API_BASE = `${API_ORIGIN}${APP_BASE}`;
const MEDIA_DETAIL_CACHE_TTL_MS = 5 * 60 * 1000;
const MEDIA_DETAIL_CACHE_MAX_ENTRIES = 50;

interface MediaDetailCacheEntry {
  data: MediaDetailData;
  expiresAt: number;
}

interface MediaDetailRequest {
  id: string;
  controller: AbortController;
  consumers: number;
  invalidated: boolean;
  settled: boolean;
  promise: Promise<MediaDetailData>;
}

const mediaDetailCache = new Map<string, MediaDetailCacheEntry>();
const mediaDetailRequests = new Map<string, MediaDetailRequest>();

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  if (!response.ok) {
    let message = `请求失败（${response.status}）`;
    try {
      const body = (await response.json()) as { detail?: string | unknown[] };
      if (typeof body.detail === "string") {
        message = body.detail;
      } else if (Array.isArray(body.detail) && body.detail.length > 0) {
        const first = body.detail[0] as { msg?: string };
        message = first.msg ?? message;
      }
    } catch {
      // Keep the status-based fallback for non-JSON responses.
    }
    throw new ApiError(message, response.status);
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export async function listMedia(
  type?: MediaType,
  query = "",
  page = 1,
  pageSize = 24,
  options?: { signal?: AbortSignal },
): Promise<MediaListData> {
  const params = new URLSearchParams({
    page: String(page),
    page_size: String(pageSize),
  });
  if (type) params.set("type", type);
  if (query.trim()) params.set("q", query.trim());
  return apiFetch<MediaListData>(`/api/media?${params}`, {
    signal: options?.signal,
  });
}

function cacheMediaDetail(id: string, data: MediaDetailData): void {
  const now = Date.now();
  for (const [cachedId, entry] of mediaDetailCache) {
    if (entry.expiresAt <= now) mediaDetailCache.delete(cachedId);
  }

  mediaDetailCache.delete(id);
  while (mediaDetailCache.size >= MEDIA_DETAIL_CACHE_MAX_ENTRIES) {
    const oldestId = mediaDetailCache.keys().next().value as string | undefined;
    if (oldestId === undefined) break;
    mediaDetailCache.delete(oldestId);
  }
  mediaDetailCache.set(id, {
    data,
    expiresAt: now + MEDIA_DETAIL_CACHE_TTL_MS,
  });
}

export function getCachedMedia(id: string): MediaDetailData | undefined {
  const entry = mediaDetailCache.get(id);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    mediaDetailCache.delete(id);
    return undefined;
  }

  // Refresh insertion order so the Map also serves as an LRU queue.
  mediaDetailCache.delete(id);
  mediaDetailCache.set(id, entry);
  return entry.data;
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

function startMediaDetailRequest(id: string): MediaDetailRequest {
  const controller = new AbortController();
  const request = {
    id,
    controller,
    consumers: 0,
    invalidated: false,
    settled: false,
    promise: Promise.resolve(undefined as unknown as MediaDetailData),
  };

  request.promise = apiFetch<MediaDetailData>(`/api/media/${id}`, {
    signal: controller.signal,
  })
    .then((data) => {
      if (!request.invalidated) cacheMediaDetail(id, data);
      return data;
    })
    .finally(() => {
      request.settled = true;
      if (mediaDetailRequests.get(id) === request) {
        mediaDetailRequests.delete(id);
      }
    });

  mediaDetailRequests.set(id, request);
  return request;
}

function subscribeToMediaDetailRequest(
  request: MediaDetailRequest,
  signal?: AbortSignal,
): Promise<MediaDetailData> {
  request.consumers += 1;

  const release = () => {
    request.consumers = Math.max(0, request.consumers - 1);
    if (request.consumers === 0 && !request.settled) {
      request.invalidated = true;
      if (mediaDetailRequests.get(request.id) === request) {
        mediaDetailRequests.delete(request.id);
      }
      request.controller.abort();
    }
  };

  if (!signal) {
    return request.promise.finally(release);
  }

  return new Promise<MediaDetailData>((resolve, reject) => {
    let finished = false;
    const finish = () => {
      if (finished) return false;
      finished = true;
      signal.removeEventListener("abort", onAbort);
      release();
      return true;
    };
    const onAbort = () => {
      if (finish()) reject(abortError());
    };

    signal.addEventListener("abort", onAbort, { once: true });
    request.promise.then(
      (data) => {
        if (finish()) resolve(data);
      },
      (reason: unknown) => {
        if (finish()) reject(reason);
      },
    );
    if (signal.aborted) onAbort();
  });
}

export function getMedia(
  id: string,
  options?: { signal?: AbortSignal; fresh?: boolean },
): Promise<MediaDetailData> {
  if (options?.signal?.aborted) {
    return Promise.reject(abortError());
  }

  if (!options?.fresh) {
    const cached = getCachedMedia(id);
    if (cached) return Promise.resolve(cached);
  } else {
    mediaDetailCache.delete(id);
    const existing = mediaDetailRequests.get(id);
    if (existing) {
      existing.invalidated = true;
      mediaDetailRequests.delete(id);
    }
  }

  const request =
    mediaDetailRequests.get(id) ?? startMediaDetailRequest(id);
  return subscribeToMediaDetailRequest(request, options?.signal);
}

export async function prefetchMedia(id: string): Promise<void> {
  try {
    await getMedia(id);
  } catch {
    // Intent prefetches are best effort. A later navigation retries normally.
  }
}

export function invalidateMediaDetail(id: string): void {
  mediaDetailCache.delete(id);
  const request = mediaDetailRequests.get(id);
  if (request) {
    mediaDetailRequests.delete(id);
    request.invalidated = true;
    request.controller.abort();
  }
}

export function clearMediaDetailCache(): void {
  mediaDetailCache.clear();
  for (const request of mediaDetailRequests.values()) {
    request.invalidated = true;
    request.controller.abort();
  }
  mediaDetailRequests.clear();
}

export async function renameMedia(
  id: string,
  title: string,
): Promise<MediaCardData> {
  const updated = await apiFetch<MediaCardData>(`/api/media/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ title }),
  });
  invalidateMediaDetail(id);
  return updated;
}

export async function deleteMedia(id: string): Promise<void> {
  await apiFetch<void>(`/api/media/${id}`, { method: "DELETE" });
  invalidateMediaDetail(id);
}
