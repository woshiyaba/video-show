import type {
  MediaCardData,
  MediaDetailData,
  MediaListData,
  MediaType,
} from "./types";

const API_ORIGIN = (import.meta.env.VITE_API_ORIGIN ?? "").replace(/\/$/, "");
const APP_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const API_BASE = `${API_ORIGIN}${APP_BASE}`;

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
): Promise<MediaListData> {
  const params = new URLSearchParams({
    page: String(page),
    page_size: String(pageSize),
  });
  if (type) params.set("type", type);
  if (query.trim()) params.set("q", query.trim());
  return apiFetch<MediaListData>(`/api/media?${params}`);
}

export function getMedia(id: string): Promise<MediaDetailData> {
  return apiFetch<MediaDetailData>(`/api/media/${id}`);
}

export function renameMedia(id: string, title: string): Promise<MediaCardData> {
  return apiFetch<MediaCardData>(`/api/media/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ title }),
  });
}

export function deleteMedia(id: string): Promise<void> {
  return apiFetch<void>(`/api/media/${id}`, { method: "DELETE" });
}
