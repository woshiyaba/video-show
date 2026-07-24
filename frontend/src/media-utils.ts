import type { MediaType, UploadMetadata } from "./types";

const VIDEO_TYPES = new Set(["video/mp4", "video/webm", "video/ogg"]);
const PHOTO_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
]);

const EXTENSION_MIME: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  ogg: "video/ogg",
  ogv: "video/ogg",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
};

export function inferMimeType(file: File): string {
  if (VIDEO_TYPES.has(file.type) || PHOTO_TYPES.has(file.type)) {
    return file.type;
  }
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_MIME[extension] ?? file.type;
}

export function inferMediaType(file: File): MediaType | null {
  const mimeType = inferMimeType(file);
  if (VIDEO_TYPES.has(mimeType)) return "video";
  if (PHOTO_TYPES.has(mimeType)) return "photo";
  return null;
}

export function titleFromFilename(filename: string): string {
  const withoutExtension = filename.replace(/\.[^.]+$/, "");
  return withoutExtension.trim() || "未命名影像";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const digits = value >= 10 ? 1 : 2;
  return `${value.toFixed(digits).replace(/\.0+$/, "")} ${units[index]}`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "";
  const rounded = Math.max(0, Math.round(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remaining = rounded % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`
    : `${minutes}:${String(remaining).padStart(2, "0")}`;
}

export function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (webpBlob) => {
        if (webpBlob) {
          resolve(webpBlob);
          return;
        }
        canvas.toBlob(
          (jpegBlob) =>
            jpegBlob
              ? resolve(jpegBlob)
              : reject(new Error("无法生成缩略图")),
          "image/jpeg",
          0.84,
        );
      },
      "image/webp",
      0.82,
    );
  });
}

function drawContained(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  maxWidth: number,
  maxHeight: number,
): HTMLCanvasElement {
  const scale = Math.min(1, maxWidth / sourceWidth, maxHeight / sourceHeight);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sourceWidth * scale));
  canvas.height = Math.max(1, Math.round(sourceHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前浏览器无法处理缩略图");
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function drawVideoCover(
  video: HTMLVideoElement,
  width: number,
  height: number,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 360;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前浏览器无法截取视频封面");

  const sourceRatio = width / height;
  const targetRatio = canvas.width / canvas.height;
  let sx = 0;
  let sy = 0;
  let sw = width;
  let sh = height;
  if (sourceRatio > targetRatio) {
    sw = height * targetRatio;
    sx = (width - sw) / 2;
  } else {
    sh = width / targetRatio;
    sy = (height - sh) / 2;
  }
  context.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function waitForEvent(
  element: HTMLMediaElement,
  successEvent: keyof HTMLMediaElementEventMap,
  timeoutMs = 15000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("读取媒体信息超时"));
    }, timeoutMs);
    const onSuccess = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("浏览器无法读取该媒体文件"));
    };
    const cleanup = () => {
      window.clearTimeout(timeout);
      element.removeEventListener(successEvent, onSuccess);
      element.removeEventListener("error", onError);
    };
    element.addEventListener(successEvent, onSuccess, { once: true });
    element.addEventListener("error", onError, { once: true });
  });
}

async function prepareVideo(file: File, mimeType: string): Promise<UploadMetadata> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "metadata";
  video.muted = true;
  video.playsInline = true;
  video.src = url;
  try {
    await waitForEvent(video, "loadedmetadata");
    if (!video.videoWidth || !video.videoHeight || !Number.isFinite(video.duration)) {
      throw new Error("视频缺少可读取的画面或时长信息");
    }
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      await waitForEvent(video, "loadeddata");
    }
    const seekTo = Math.min(1, Math.max(0, video.duration * 0.2));
    if (seekTo > 0.01) {
      video.currentTime = seekTo;
      await waitForEvent(video, "seeked");
    }
    const canvas = drawVideoCover(video, video.videoWidth, video.videoHeight);
    return {
      mediaType: "video",
      mimeType,
      width: video.videoWidth,
      height: video.videoHeight,
      durationSeconds: video.duration,
      thumbnail: await canvasToBlob(canvas),
    };
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

async function preparePhoto(file: File, mimeType: string): Promise<UploadMetadata> {
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.decoding = "async";
  image.src = url;
  try {
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight) {
      throw new Error("图片尺寸无效");
    }
    const canvas = drawContained(
      image,
      image.naturalWidth,
      image.naturalHeight,
      960,
      720,
    );
    return {
      mediaType: "photo",
      mimeType,
      width: image.naturalWidth,
      height: image.naturalHeight,
      thumbnail: await canvasToBlob(canvas),
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function prepareMedia(file: File): Promise<UploadMetadata> {
  const mediaType = inferMediaType(file);
  const mimeType = inferMimeType(file);
  if (!mediaType) {
    throw new Error("仅支持 MP4/WebM/Ogg 视频及 JPEG/PNG/WebP/GIF/AVIF 图片");
  }
  return mediaType === "video"
    ? prepareVideo(file, mimeType)
    : preparePhoto(file, mimeType);
}
