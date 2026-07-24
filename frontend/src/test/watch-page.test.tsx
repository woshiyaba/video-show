import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import * as api from "../api";
import { WatchPage } from "../pages/WatchPage";
import type { MediaDetailData } from "../types";
import { deferred, mediaCard, mediaDetail, mediaList } from "./fixtures";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    getMedia: vi.fn(),
    listMedia: vi.fn(),
    prefetchMedia: vi.fn(() => Promise.resolve()),
  };
});

const getMediaMock = vi.mocked(api.getMedia);
const listMediaMock = vi.mocked(api.listMedia);

function renderWatchPage(path = "/watch/clip") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/watch/:id" element={<WatchPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function getVideo(container: HTMLElement): HTMLVideoElement {
  const video = container.querySelector("video");
  if (!(video instanceof HTMLVideoElement)) {
    throw new Error("Expected the video player to be rendered");
  }
  return video;
}

function bufferedRange(start: number, end: number): TimeRanges {
  return {
    length: 1,
    start: (index: number) => {
      if (index !== 0) throw new DOMException("IndexSizeError");
      return start;
    },
    end: (index: number) => {
      if (index !== 0) throw new DOMException("IndexSizeError");
      return end;
    },
  };
}

describe("WatchPage progressive playback", () => {
  let loadSpy: ReturnType<typeof vi.spyOn>;
  let pauseSpy: ReturnType<typeof vi.spyOn>;
  let playSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    getMediaMock.mockReset();
    listMediaMock.mockReset();
    listMediaMock.mockResolvedValue(mediaList([]));
    vi.mocked(api.prefetchMedia).mockClear();
    Object.defineProperty(navigator, "connection", {
      configurable: true,
      value: undefined,
    });
    loadSpy = vi
      .spyOn(HTMLMediaElement.prototype, "load")
      .mockImplementation(() => undefined);
    pauseSpy = vi
      .spyOn(HTMLMediaElement.prototype, "pause")
      .mockImplementation(() => undefined);
    playSpy = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders detail before requesting recommendations", async () => {
    const related = deferred<ReturnType<typeof mediaList>>();
    getMediaMock.mockResolvedValue(
      mediaDetail("clip", { title: "先显示的当前视频" }),
    );
    listMediaMock.mockReturnValue(related.promise);

    const { container } = renderWatchPage();

    expect(
      await screen.findByRole("heading", { name: "先显示的当前视频" }),
    ).toBeInTheDocument();
    expect(listMediaMock).not.toHaveBeenCalled();
    expect(getVideo(container)).toHaveAttribute(
      "src",
      "https://media.example/clip.mp4",
    );
    expect(loadSpy).toHaveBeenCalled();

    fireEvent.canPlay(getVideo(container));
    await waitFor(() => expect(listMediaMock).toHaveBeenCalledTimes(1));
    expect(
      screen.getByRole("heading", { name: "先显示的当前视频" }),
    ).toBeInTheDocument();

    related.resolve(mediaList([]));
  });

  it("keeps the player usable when recommendations fail", async () => {
    getMediaMock.mockResolvedValue(
      mediaDetail("clip", { title: "仍可播放的视频" }),
    );
    listMediaMock.mockRejectedValue(new Error("推荐服务暂时不可用"));

    const { container } = renderWatchPage();
    expect(
      await screen.findByRole("heading", { name: "仍可播放的视频" }),
    ).toBeInTheDocument();
    fireEvent.canPlay(getVideo(container));

    expect(
      await screen.findByText("推荐服务暂时不可用"),
    ).toBeInTheDocument();
    expect(getVideo(container)).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "无法打开这段视频" }),
    ).not.toBeInTheDocument();
  });

  it.each([
    { saveData: false, expected: "auto" },
    { saveData: true, expected: "metadata" },
  ])(
    "uses preload=$expected when saveData=$saveData",
    async ({ saveData, expected }) => {
      Object.defineProperty(navigator, "connection", {
        configurable: true,
        value: { saveData },
      });
      getMediaMock.mockResolvedValue(mediaDetail("clip"));

      const { container } = renderWatchPage();

      await screen.findByRole("heading", { name: "视频 clip" });
      expect(getVideo(container)).toHaveAttribute("preload", expected);
    },
  );

  it("shows buffered seconds on waiting and lets the viewer resume immediately", async () => {
    getMediaMock.mockResolvedValue(mediaDetail("clip"));
    const { container } = renderWatchPage();
    await screen.findByRole("heading", { name: "视频 clip" });
    const video = getVideo(container);
    Object.defineProperties(video, {
      buffered: {
        configurable: true,
        value: bufferedRange(0, 3.8),
      },
      currentTime: { configurable: true, writable: true, value: 1 },
      duration: { configurable: true, value: 60 },
    });

    fireEvent.playing(video);
    fireEvent.waiting(video);

    expect(
      await screen.findByText("网络有些慢，正在多缓冲一点…"),
    ).toBeInTheDocument();
    expect(screen.getByText("已准备 2 秒")).toBeInTheDocument();
    expect(pauseSpy).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "立即播放" }));
    expect(playSpy).toHaveBeenCalled();
    fireEvent.playing(video);
    await waitFor(() => {
      expect(
        screen.queryByText("网络有些慢，正在多缓冲一点…"),
      ).not.toBeInTheDocument();
    });
  });

  it("aborts the previous detail request and ignores its late result", async () => {
    const oldDetail = deferred<MediaDetailData>();
    const newDetail = deferred<MediaDetailData>();
    getMediaMock.mockImplementation((id, options) => {
      const source = id === "old" ? oldDetail : newDetail;
      return new Promise<MediaDetailData>((resolve, reject) => {
        source.promise.then(resolve, reject);
        options?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    });

    render(
      <MemoryRouter initialEntries={["/watch/old"]}>
        <Link to="/watch/new">切换视频</Link>
        <Routes>
          <Route path="/watch/:id" element={<WatchPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(getMediaMock).toHaveBeenCalledTimes(1));
    const oldSignal = getMediaMock.mock.calls[0][1]?.signal;

    fireEvent.click(screen.getByRole("link", { name: "切换视频" }));
    await waitFor(() => expect(getMediaMock).toHaveBeenCalledTimes(2));
    expect(oldSignal?.aborted).toBe(true);

    newDetail.resolve(mediaDetail("new", { title: "新的当前视频" }));
    expect(
      await screen.findByRole("heading", { name: "新的当前视频" }),
    ).toBeInTheDocument();
    oldDetail.resolve(mediaDetail("old", { title: "过期的旧视频" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText("过期的旧视频")).not.toBeInTheDocument();
  });

  it("refreshes an expired media URL after a playback error", async () => {
    const refreshed = deferred<MediaDetailData>();
    getMediaMock
      .mockResolvedValueOnce(mediaDetail("clip"))
      .mockReturnValueOnce(refreshed.promise);
    const { container } = renderWatchPage();
    await screen.findByRole("heading", { name: "视频 clip" });
    const video = getVideo(container);
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      writable: true,
      value: 42,
    });
    fireEvent.playing(video);
    fireEvent.error(video);

    expect(
      await screen.findByText("视频加载中断，请重新加载后继续观看。"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
    expect(getMediaMock).toHaveBeenLastCalledWith("clip", { fresh: true });

    refreshed.resolve(
      mediaDetail("clip", {
        content_url: "https://media.example/clip-refreshed.mp4",
      }),
    );
    await waitFor(() => {
      expect(getVideo(container)).toHaveAttribute(
        "src",
        "https://media.example/clip-refreshed.mp4",
      );
    });
    const refreshedVideo = getVideo(container);
    Object.defineProperty(refreshedVideo, "duration", {
      configurable: true,
      value: 90,
    });
    fireEvent.loadedMetadata(refreshedVideo);
    expect(refreshedVideo.currentTime).toBe(42);
    fireEvent.seeked(refreshedVideo);
    expect(playSpy).toHaveBeenCalled();
  });
});
