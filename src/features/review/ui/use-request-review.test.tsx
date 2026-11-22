// @vitest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse, server } from "@/test/msw";
import type { ReviewJobStatus } from "./review-client";
import { useRequestReview } from "./use-request-review";

const body = { requested: 1, curriculum: null, questions: [] };
const URL_PATH = "/api/generation/r1/questions";
let requests: Request[];

beforeEach(() => {
  requests = [];
  server.use(
    http.get(URL_PATH, ({ request }) => {
      requests.push(request.clone());
      return HttpResponse.json(body, { status: 200 });
    }),
  );
});
afterEach(() => {
  cleanup();
});

function setup(initial: ReviewJobStatus) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const view = renderHook(({ status }) => useRequestReview("r1", status), {
    wrapper,
    initialProps: { status: initial },
  });
  return { client, ...view };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("useRequestReview", () => {
  it("fetches once on mount", async () => {
    const { result } = setup("running");
    await waitFor(() => {
      expect(result.current.data?.kind).toBe("ok");
    });
    await settle();
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0].url).pathname).toBe(URL_PATH);
    expect(requests[0].method).toBe("GET");
    expect(requests[0].headers.get("accept")).toBe("application/json");
  });

  it("fetches exactly once more when the job turns from running to succeeded", async () => {
    const { result, rerender } = setup("running");
    await waitFor(() => {
      expect(result.current.data?.kind).toBe("ok");
    });
    rerender({ status: "succeeded" });
    await waitFor(() => {
      expect(requests).toHaveLength(2);
    });
    await settle();
    expect(requests).toHaveLength(2);
  });

  it("does not refetch when the job is already succeeded at mount", async () => {
    const mounted = setup("succeeded");
    await waitFor(() => {
      expect(mounted.result.current.data?.kind).toBe("ok");
    });
    await settle();
    expect(requests).toHaveLength(1);
  });

  it("refetches once when a review fetched with an unknown job status turns terminal", async () => {
    const { result, rerender } = setup(undefined);
    await waitFor(() => {
      expect(result.current.data?.kind).toBe("ok");
    });
    await settle();
    rerender({ status: "succeeded" });
    await waitFor(() => {
      expect(requests).toHaveLength(2);
    });
    await settle();
    expect(requests).toHaveLength(2);
  });

  it("does not refetch when an unknown job status resolves to a running one", async () => {
    const { result, rerender } = setup(undefined);
    await waitFor(() => {
      expect(result.current.data?.kind).toBe("ok");
    });
    rerender({ status: "running" });
    await settle();
    expect(requests).toHaveLength(1);
  });

  it("wires the polling interval through the helper", async () => {
    const { client, result, rerender } = setup("running");
    await waitFor(() => {
      expect(result.current.data?.kind).toBe("ok");
    });
    const interval = () => {
      const query = client.getQueryCache().find({ queryKey: ["request-review", "r1"] })!;
      const option = query.observers[0].options.refetchInterval;
      return typeof option === "function" ? option(query) : option;
    };
    expect(interval()).toBe(3000);
    rerender({ status: "deferred" });
    expect(interval()).toBe(15_000);
    rerender({ status: "succeeded" });
    expect(interval()).toBe(false);
    rerender({ status: "stopped" });
    expect(interval()).toBe(false);
  });
});
