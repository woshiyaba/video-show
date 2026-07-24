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
import { VideoLibrary } from "../pages/VideoLibrary";
import { deferred, mediaCard, mediaList } from "./fixtures";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    listMedia: vi.fn(),
    prefetchMedia: vi.fn(() => Promise.resolve()),
  };
});

const listMediaMock = vi.mocked(api.listMedia);

interface IdleCallbackRegistration {
  callback: () => void;
  options?: { timeout: number };
}

describe("VideoLibrary pagination prefetch", () => {
  let idleCallbacks: IdleCallbackRegistration[];
  let observerCallback: IntersectionObserverCallback | undefined;
  let observerOptions: IntersectionObserverInit | undefined;
  const observer = {
    root: null,
    rootMargin: "",
    thresholds: [],
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
    takeRecords: vi.fn(() => []),
  } satisfies IntersectionObserver;

  beforeEach(() => {
    idleCallbacks = [];
    observerCallback = undefined;
    observerOptions = undefined;
    listMediaMock.mockReset();
    vi.mocked(api.prefetchMedia).mockClear();

    vi.stubGlobal(
      "requestIdleCallback",
      vi.fn(
        (
          callback: () => void,
          options?: { timeout: number },
        ): number => {
          idleCallbacks.push({ callback, options });
          return idleCallbacks.length;
        },
      ),
    );
    vi.stubGlobal("cancelIdleCallback", vi.fn());
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(
        (
          callback: IntersectionObserverCallback,
          options?: IntersectionObserverInit,
        ) => {
          observerCallback = callback;
          observerOptions = options;
          return observer;
        },
      ),
    );
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    Object.defineProperty(navigator, "connection", {
      configurable: true,
      value: undefined,
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("prefetches page two while idle and reuses it when the sentinel enters view", async () => {
    const firstPage = Array.from({ length: 24 }, (_, index) =>
      mediaCard(`first-${index}`, {
        title: index === 0 ? "首页重复项" : `首页视频 ${index}`,
      }),
    );
    const pageTwo = deferred<ReturnType<typeof mediaList>>();
    listMediaMock.mockImplementation((_type, _query, page) => {
      if (page === 1) {
        return Promise.resolve(
          mediaList(firstPage, { total: 26, page: 1, page_size: 24 }),
        );
      }
      return pageTwo.promise;
    });

    render(
      <MemoryRouter>
        <VideoLibrary />
      </MemoryRouter>,
    );

    expect(await screen.findByText("首页重复项")).toBeInTheDocument();
    expect(idleCallbacks).toHaveLength(1);
    expect(idleCallbacks[0].options).toEqual({ timeout: 1_500 });

    act(() => idleCallbacks[0].callback());
    await waitFor(() => expect(listMediaMock).toHaveBeenCalledTimes(2));
    expect(listMediaMock).toHaveBeenLastCalledWith(
      "video",
      "",
      2,
      24,
      { signal: expect.any(AbortSignal) },
    );
    expect(screen.queryByText("预取的新视频")).not.toBeInTheDocument();

    await waitFor(() => expect(observerCallback).toBeDefined());
    expect(observerOptions).toEqual({ rootMargin: "600px 0px" });
    act(() => {
      const entry = { isIntersecting: true } as IntersectionObserverEntry;
      observerCallback?.([entry], observer);
      observerCallback?.([entry], observer);
    });
    pageTwo.resolve(
      mediaList(
        [
          mediaCard("first-0", { title: "首页重复项" }),
          mediaCard("new-item", { title: "预取的新视频" }),
        ],
        { total: 26, page: 2, page_size: 24 },
      ),
    );

    expect(await screen.findByText("预取的新视频")).toBeInTheDocument();
    expect(screen.getAllByText("首页重复项")).toHaveLength(1);
    expect(listMediaMock).toHaveBeenCalledTimes(2);
  });

  it("aborts the old search and ignores its late response", async () => {
    const oldResult = deferred<ReturnType<typeof mediaList>>();
    const newResult = deferred<ReturnType<typeof mediaList>>();
    listMediaMock.mockImplementation((_type, query) => {
      return query === "旧搜索" ? oldResult.promise : newResult.promise;
    });

    render(
      <MemoryRouter initialEntries={["/?q=旧搜索"]}>
        <Link to="/?q=新搜索">切换搜索</Link>
        <Routes>
          <Route path="/" element={<VideoLibrary />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(listMediaMock).toHaveBeenCalledTimes(1));
    const oldSignal = listMediaMock.mock.calls[0][4]?.signal;
    fireEvent.click(screen.getByRole("link", { name: "切换搜索" }));

    await waitFor(() => expect(listMediaMock).toHaveBeenCalledTimes(2));
    expect(oldSignal?.aborted).toBe(true);
    newResult.resolve(
      mediaList([mediaCard("new", { title: "新搜索结果" })]),
    );
    expect(await screen.findByText("新搜索结果")).toBeInTheDocument();

    oldResult.resolve(
      mediaList([mediaCard("old", { title: "不应出现的旧结果" })]),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText("不应出现的旧结果")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "“新搜索”的搜索结果" }))
      .toBeInTheDocument();
  });

  it("does not schedule background prefetch when data saving is enabled", async () => {
    Object.defineProperty(navigator, "connection", {
      configurable: true,
      value: { saveData: true, effectiveType: "4g" },
    });
    const firstPage = Array.from({ length: 24 }, (_, index) =>
      mediaCard(`save-data-${index}`),
    );
    listMediaMock.mockResolvedValue(
      mediaList(firstPage, { total: 48, page: 1, page_size: 24 }),
    );

    render(
      <MemoryRouter>
        <VideoLibrary />
      </MemoryRouter>,
    );

    expect(await screen.findByText("视频 save-data-0")).toBeInTheDocument();
    expect(idleCallbacks).toHaveLength(0);
    expect(listMediaMock).toHaveBeenCalledTimes(1);
  });

  it("requires the sentinel to leave before auto-appending another page", async () => {
    const pages = new Map(
      [1, 2, 3].map((page) => [
        page,
        Array.from({ length: 24 }, (_, index) =>
          mediaCard(`page-${page}-${index}`, {
            title: `第 ${page} 页视频 ${index}`,
          }),
        ),
      ]),
    );
    listMediaMock.mockImplementation((_type, _query, page = 1) => {
      return Promise.resolve(
        mediaList(pages.get(page) ?? [], {
          total: 72,
          page,
          page_size: 24,
        }),
      );
    });

    render(
      <MemoryRouter>
        <VideoLibrary />
      </MemoryRouter>,
    );
    expect(await screen.findByText("第 1 页视频 0")).toBeInTheDocument();

    act(() => idleCallbacks[0].callback());
    await waitFor(() => expect(listMediaMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(observerCallback).toBeDefined());
    act(() => {
      observerCallback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        observer,
      );
    });
    expect(await screen.findByText("第 2 页视频 0")).toBeInTheDocument();

    await waitFor(() => expect(idleCallbacks).toHaveLength(2));
    act(() => idleCallbacks[1].callback());
    await waitFor(() => expect(listMediaMock).toHaveBeenCalledTimes(3));

    act(() => {
      observerCallback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        observer,
      );
    });
    expect(screen.queryByText("第 3 页视频 0")).not.toBeInTheDocument();

    act(() => {
      observerCallback?.(
        [{ isIntersecting: false } as IntersectionObserverEntry],
        observer,
      );
      observerCallback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        observer,
      );
    });
    expect(await screen.findByText("第 3 页视频 0")).toBeInTheDocument();
    expect(listMediaMock).toHaveBeenCalledTimes(3);
  });
});
