import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatDuration,
  inferMediaType,
  inferMimeType,
  titleFromFilename,
} from "../media-utils";

describe("media utilities", () => {
  it("infers supported media from MIME type and extension", () => {
    const video = new File(["video"], "clip.mp4", { type: "" });
    const photo = new File(["photo"], "portrait.webp", { type: "image/webp" });
    const invalid = new File(["zip"], "archive.zip", {
      type: "application/zip",
    });

    expect(inferMimeType(video)).toBe("video/mp4");
    expect(inferMediaType(video)).toBe("video");
    expect(inferMediaType(photo)).toBe("photo");
    expect(inferMediaType(invalid)).toBeNull();
  });

  it("formats names, byte sizes and durations for the UI", () => {
    expect(titleFromFilename("family.trip.mp4")).toBe("family.trip");
    expect(formatBytes(1024 * 1024 * 2)).toBe("2 MB");
    expect(formatDuration(65)).toBe("1:05");
    expect(formatDuration(3661)).toBe("1:01:01");
  });
});
