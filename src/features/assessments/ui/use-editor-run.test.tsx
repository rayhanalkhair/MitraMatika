// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { intlWrapper } from "@/test/intl";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import { useEditorRun } from "./use-editor-run";

describe("useEditorRun", () => {
  it("refreshes after a refusal only when asked, and shows the refusal", async () => {
    const { result } = renderHook(() => useEditorRun(), { wrapper: intlWrapper() });
    act(() => {
      result.current.run(() => Promise.resolve({ ok: false, reason: "conflict" }), {
        done: "x",
      });
    });
    await waitFor(() => {
      expect(result.current.problem).not.toBe("");
    });
    expect(refresh).not.toHaveBeenCalled();

    act(() => {
      result.current.run(() => Promise.resolve({ ok: false, reason: "notReady" }), {
        done: "x",
        focus: ["approve"],
        refreshOnRefusal: true,
      });
    });
    await waitFor(() => {
      expect(refresh).toHaveBeenCalledTimes(1);
    });
    expect(result.current.focusIds).toEqual(["approve"]);
  });
});
