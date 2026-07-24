import { apiFetch } from "./api";
import type { MediaCardData, UploadMetadata } from "./types";

interface InitiateResponse {
  session_id: string;
  part_size_bytes: number;
  total_parts: number;
  expires_at: string;
  thumbnail_upload: {
    url: string;
    headers: Record<string, string>;
  } | null;
}

interface SignedPart {
  part_number: number;
  url: string;
}

interface SignResponse {
  parts: SignedPart[];
}

interface CompleteResponse {
  media: MediaCardData;
}

export class UploadCancelledError extends Error {
  constructor() {
    super("上传已取消");
    this.name = "UploadCancelledError";
  }
}

export class UploadController {
  private stopped = false;
  private requests = new Set<XMLHttpRequest>();

  get aborted(): boolean {
    return this.stopped;
  }

  register(request: XMLHttpRequest): void {
    this.requests.add(request);
  }

  unregister(request: XMLHttpRequest): void {
    this.requests.delete(request);
  }

  throwIfAborted(): void {
    if (this.stopped) throw new UploadCancelledError();
  }

  abort(): void {
    this.stopped = true;
    this.requests.forEach((request) => request.abort());
    this.requests.clear();
  }
}

interface PutOptions {
  headers?: Record<string, string>;
  requireEtag?: boolean;
  onProgress?: (loaded: number) => void;
  controller: UploadController;
}

function putBlob(
  url: string,
  body: Blob,
  options: PutOptions,
): Promise<string | null> {
  options.controller.throwIfAborted();
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    options.controller.register(request);
    request.open("PUT", url);
    Object.entries(options.headers ?? {}).forEach(([name, value]) => {
      request.setRequestHeader(name, value);
    });
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) options.onProgress?.(event.loaded);
    };
    request.onerror = () => {
      cleanup();
      reject(new Error("上传到 COS 时网络连接失败"));
    };
    request.onabort = () => {
      cleanup();
      reject(new UploadCancelledError());
    };
    request.onload = () => {
      cleanup();
      if (request.status < 200 || request.status >= 300) {
        reject(new Error(`COS 上传失败（${request.status}）`));
        return;
      }
      const etag = request.getResponseHeader("ETag");
      if (options.requireEtag && !etag) {
        reject(
          new Error(
            "COS 响应缺少 ETag，请在存储桶 CORS 中暴露 ETag 响应头",
          ),
        );
        return;
      }
      resolve(etag);
    };
    const cleanup = () => options.controller.unregister(request);
    request.send(body);
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function putWithRetry(
  url: string,
  body: Blob,
  options: PutOptions,
): Promise<string | null> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    options.controller.throwIfAborted();
    try {
      return await putBlob(url, body, options);
    } catch (error) {
      if (error instanceof UploadCancelledError) throw error;
      lastError = error;
      if (attempt < 3) await delay(attempt * 450);
    }
  }
  throw lastError;
}

async function runPool<T>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        await worker(values[index]);
      }
    },
  );
  await Promise.all(runners);
}

export interface UploadMediaOptions {
  file: File;
  title: string;
  metadata: UploadMetadata;
  controller: UploadController;
  onProgress: (percentage: number) => void;
}

export async function uploadMedia({
  file,
  title,
  metadata,
  controller,
  onProgress,
}: UploadMediaOptions): Promise<MediaCardData> {
  let sessionId: string | null = null;
  let completed = false;
  const loadedParts = new Map<number, number>();

  const reportProgress = () => {
    const loaded = [...loadedParts.values()].reduce(
      (sum, value) => sum + value,
      0,
    );
    onProgress(Math.min(99, Math.round((loaded / file.size) * 100)));
  };

  try {
    controller.throwIfAborted();
    const initiated = await apiFetch<InitiateResponse>("/api/uploads/initiate", {
      method: "POST",
      body: JSON.stringify({
        title: title.trim(),
        media_type: metadata.mediaType,
        original_filename: file.name,
        mime_type: metadata.mimeType,
        size_bytes: file.size,
        duration_seconds: metadata.durationSeconds ?? null,
        width: metadata.width,
        height: metadata.height,
        thumbnail_mime_type: metadata.thumbnail.type || "image/webp",
      }),
    });
    sessionId = initiated.session_id;

    if (initiated.thumbnail_upload) {
      await putWithRetry(initiated.thumbnail_upload.url, metadata.thumbnail, {
        headers: initiated.thumbnail_upload.headers,
        controller,
      });
    }

    const completedParts: Array<{ part_number: number; etag: string }> = [];
    const allPartNumbers = Array.from(
      { length: initiated.total_parts },
      (_, index) => index + 1,
    );

    for (let offset = 0; offset < allPartNumbers.length; offset += 20) {
      controller.throwIfAborted();
      const batch = allPartNumbers.slice(offset, offset + 20);
      const signed = await apiFetch<SignResponse>(
        `/api/uploads/${sessionId}/parts/sign`,
        {
          method: "POST",
          body: JSON.stringify({ part_numbers: batch }),
        },
      );

      await runPool(signed.parts, 4, async (part) => {
        controller.throwIfAborted();
        const start = (part.part_number - 1) * initiated.part_size_bytes;
        const end = Math.min(start + initiated.part_size_bytes, file.size);
        const chunk = file.slice(start, end, metadata.mimeType);
        loadedParts.set(part.part_number, 0);
        const etag = await putWithRetry(part.url, chunk, {
          requireEtag: true,
          controller,
          onProgress: (loaded) => {
            loadedParts.set(part.part_number, loaded);
            reportProgress();
          },
        });
        loadedParts.set(part.part_number, chunk.size);
        reportProgress();
        completedParts.push({
          part_number: part.part_number,
          etag: etag as string,
        });
      });
    }

    controller.throwIfAborted();
    const result = await apiFetch<CompleteResponse>(
      `/api/uploads/${sessionId}/complete`,
      {
        method: "POST",
        body: JSON.stringify({ parts: completedParts }),
      },
    );
    completed = true;
    onProgress(100);
    return result.media;
  } catch (error) {
    controller.abort();
    if (sessionId && !completed) {
      try {
        await apiFetch<void>(`/api/uploads/${sessionId}`, {
          method: "DELETE",
        });
      } catch {
        // The upload session expires and is cleaned server-side if cancellation fails.
      }
    }
    throw error;
  }
}
