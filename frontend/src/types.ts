export type MediaType = "video" | "photo";
export type ProcessingStatus = "processing" | "ready" | "failed";
export type PlaybackType = "direct" | "hls" | "unavailable";

export interface MediaCardData {
  id: string;
  media_type: MediaType;
  title: string;
  original_filename: string;
  thumbnail_url: string | null;
  mime_type: string;
  size_bytes: number;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  processing_status: ProcessingStatus;
  playback_type: PlaybackType;
  processing_error: string | null;
  playback_size_bytes: number | null;
  created_at: string;
  updated_at: string;
}

export interface MediaDetailData extends MediaCardData {
  content_url: string | null;
}

export interface MediaListData {
  items: MediaCardData[];
  total: number;
  page: number;
  page_size: number;
}

export interface UploadMetadata {
  mediaType: MediaType;
  mimeType: string;
  width: number;
  height: number;
  durationSeconds?: number;
  thumbnail: Blob;
}
