import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearMediaDetailCache,
  deleteMedia,
  getCachedMedia,
  getMedia,
  invalidateMediaDetail,
  listMedia,
  renameMedia,
} from "../api";
import { deferred, mediaCard, mediaDetail, mediaList } from "./fixtures";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("media API request cache", () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    clearMediaDetailCache();
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("coalesces concurrent detail requests and serves the fresh cache", async () => {
    const pending = deferred<Response>();
    const detail = mediaDetail("shared");
    fetchMock.mockReturnValueOnce(pending.promise);

    const first = getMedia("shared");
    const second = getMedia("shared");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    pending.resolve(jsonResponse(detail));

    await expect(first).resolves.toEqual(detail);
    await expect(second).resolves.toEqual(detail);
    await expect(getMedia("shared")).resolves.toEqual(detail);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getCachedMedia("shared")).toEqual(detail);
  });

  it("supports forced refresh, explicit invalidation, and a five-minute TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T08:00:00Z"));
    const first = mediaDetail("refresh", { content_url: "https://media/one" });
    const second = mediaDetail("refresh", { content_url: "https://media/two" });
    const third = mediaDetail("refresh", { content_url: "https://media/three" });
    const fourth = mediaDetail("refresh", { content_url: "https://media/four" });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(first))
      .mockResolvedValueOnce(jsonResponse(second))
      .mockResolvedValueOnce(jsonResponse(third))
      .mockResolvedValueOnce(jsonResponse(fourth));

    await expect(getMedia("refresh")).resolves.toEqual(first);
    await expect(getMedia("refresh", { fresh: true })).resolves.toEqual(second);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    invalidateMediaDetail("refresh");
    await expect(getMedia("refresh")).resolves.toEqual(third);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    await expect(getMedia("refresh")).resolves.toEqual(fourth);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("lets one subscriber abort without cancelling another subscriber", async () => {
    const pending = deferred<Response>();
    const detail = mediaDetail("abort-one");
    let underlyingSignal: AbortSignal | undefined;
    fetchMock.mockImplementation((_input, init) => {
      underlyingSignal = init?.signal ?? undefined;
      return pending.promise;
    });
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = getMedia("abort-one", {
      signal: firstController.signal,
    }).catch((reason: unknown) => reason);
    const second = getMedia("abort-one", {
      signal: secondController.signal,
    });
    firstController.abort();

    const firstError = await first;
    expect(firstError).toMatchObject({ name: "AbortError" });
    expect(underlyingSignal?.aborted).toBe(false);

    pending.resolve(jsonResponse(detail));
    await expect(second).resolves.toEqual(detail);
  });

  it("cancels the underlying request once every subscriber aborts", async () => {
    let underlyingSignal: AbortSignal | undefined;
    fetchMock.mockImplementation((_input, init) => {
      underlyingSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = getMedia("abort-all", {
      signal: firstController.signal,
    }).catch((reason: unknown) => reason);
    const second = getMedia("abort-all", {
      signal: secondController.signal,
    }).catch((reason: unknown) => reason);

    firstController.abort();
    expect(underlyingSignal?.aborted).toBe(false);
    secondController.abort();

    expect(await first).toMatchObject({ name: "AbortError" });
    expect(await second).toMatchObject({ name: "AbortError" });
    expect(underlyingSignal?.aborted).toBe(true);
  });

  it("forwards list cancellation without changing the pagination contract", async () => {
    const controller = new AbortController();
    fetchMock.mockResolvedValueOnce(jsonResponse(mediaList([])));

    await listMedia("video", " family ", 2, 24, {
      signal: controller.signal,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/video-show/api/media?page=2&page_size=24&type=video&q=family",
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("invalidates cached details after successful rename and delete mutations", async () => {
    const first = mediaDetail("rename-me");
    const second = mediaDetail("delete-me");
    fetchMock
      .mockResolvedValueOnce(jsonResponse(first))
      .mockResolvedValueOnce(jsonResponse(second))
      .mockResolvedValueOnce(
        jsonResponse(mediaCard("rename-me", { title: "新名称" })),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await getMedia("rename-me");
    await getMedia("delete-me");
    expect(getCachedMedia("rename-me")).toEqual(first);
    expect(getCachedMedia("delete-me")).toEqual(second);

    await renameMedia("rename-me", "新名称");
    expect(getCachedMedia("rename-me")).toBeUndefined();
    expect(getCachedMedia("delete-me")).toEqual(second);

    await deleteMedia("delete-me");
    expect(getCachedMedia("delete-me")).toBeUndefined();
  });
});
