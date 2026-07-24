import type {
  MediaCardData,
  MediaDetailData,
  MediaListData,
} from "../types";

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

export function mediaCard(
  id: string,
  overrides: Partial<MediaCardData> = {},
): MediaCardData {
  return {
    id,
    media_type: "video",
    title: `视频 ${id}`,
    original_filename: `${id}.mp4`,
    thumbnail_url: null,
    mime_type: "video/mp4",
    size_bytes: 8 * 1024 * 1024,
    duration_seconds: 90,
    width: 1920,
    height: 1080,
    created_at: "2026-07-25T08:00:00Z",
    updated_at: "2026-07-25T08:00:00Z",
    ...overrides,
  };
}

export function mediaDetail(
  id: string,
  overrides: Partial<MediaDetailData> = {},
): MediaDetailData {
  return {
    ...mediaCard(id),
    content_url: `https://media.example/${id}.mp4`,
    ...overrides,
  };
}

export function mediaList(
  items: MediaCardData[],
  overrides: Partial<MediaListData> = {},
): MediaListData {
  return {
    items,
    total: items.length,
    page: 1,
    page_size: 24,
    ...overrides,
  };
}
