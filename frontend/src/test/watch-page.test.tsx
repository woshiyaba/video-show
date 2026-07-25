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

const hlsMock = vi.hoisted(() => ({
  supported: false,
  instances: [] as Array<{
    source: string | null;
    destroyed: boolean;
  }>,
}));

vi.mock("hls.js", () => {
  class MockHls {
    static Events = {
      MEDIA_ATTACHED: "media-attached",
    };

    static isSupported() {
      return hlsMock.supported;
    }

    source: string | null = null;
    destroyed = false;
    callbacks = new Map<string, (...args: unknown[]) => void>();

    constructor() {
      hlsMock.instances.push(this);
    }

    on(event: string, callback: (...args: unknown[]) => void) {
      this.callbacks.set(event, callback);
    }

    attachMedia() {
      this.callbacks.get(MockHls.Events.MEDIA_ATTACHED)?.();
    }

    loadSource(source: string) {
      this.source = source;
    }

    destroy() {
      this.destroyed = true;
    }
  }

  return { default: MockHls };
});

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

describe("WatchPage progressive playback", () => {
  let loadSpy: ReturnType<typeof vi.spyOn>;
  let pauseSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    getMediaMock.mockReset();
    listMediaMock.mockReset();
    listMediaMock.mockResolvedValue(mediaList([]));
    hlsMock.supported = false;
    hlsMock.instances.length = 0;
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
    vi.spyOn(HTMLMediaElement.prototype, "play")
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

  it("shows cloud processing state without creating a player", async () => {
    getMediaMock.mockResolvedValue(
      mediaDetail("clip", {
        processing_status: "processing",
        playback_type: "unavailable",
        content_url: null,
      }),
    );

    const { container } = renderWatchPage();

    expect(
      await screen.findByRole("heading", {
        name: "视频正在云端压缩",
      }),
    ).toBeInTheDocument();
    expect(container.querySelector("video")).not.toBeInTheDocument();
  });

  it("uses hls.js ABR without the direct-video pause loop", async () => {
    hlsMock.supported = true;
    vi.spyOn(
      HTMLMediaElement.prototype,
      "canPlayType",
    ).mockReturnValue("");
    getMediaMock.mockResolvedValue(
      mediaDetail("clip", {
        playback_type: "hls",
        content_url:
          "/video-show/api/media/clip/stream/master.m3u8",
        playback_size_bytes: 12 * 1024 * 1024,
      }),
    );

    const { container } = renderWatchPage();
    await screen.findByRole("heading", { name: "视频 clip" });
    await waitFor(() => expect(hlsMock.instances).toHaveLength(1));
    expect(hlsMock.instances[0].source).toBe(
      "/video-show/api/media/clip/stream/master.m3u8",
    );

    const video = getVideo(container);
    fireEvent.playing(video);
    fireEvent.waiting(video);
    fireEvent.stalled(video);
    expect(pauseSpy).not.toHaveBeenCalled();
    expect(
      screen.queryByText("网络有些慢，正在多缓冲一点…"),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
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

  it("leaves direct-video buffering and seeking to the native player", async () => {
    getMediaMock.mockResolvedValue(mediaDetail("clip"));
    const { container } = renderWatchPage();
    await screen.findByRole("heading", { name: "视频 clip" });
    const video = getVideo(container);

    fireEvent.play(video);
    fireEvent.playing(video);
    fireEvent.waiting(video);
    fireEvent.stalled(video);
    fireEvent.seeking(video);
    fireEvent.seeked(video);

    expect(pauseSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByText(/缓冲/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "立即播放" }),
    ).not.toBeInTheDocument();
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

  it("leaves playback errors to the native player without refreshing", async () => {
    getMediaMock.mockResolvedValue(mediaDetail("clip"));
    const { container } = renderWatchPage();
    await screen.findByRole("heading", { name: "视频 clip" });
    const video = getVideo(container);

    fireEvent.error(video);

    expect(getMediaMock).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByText("视频加载中断，请重新加载后继续观看。"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "重新加载" }),
    ).not.toBeInTheDocument();
    expect(getVideo(container)).toBeInTheDocument();
  });
});
