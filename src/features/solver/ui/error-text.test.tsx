// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { intlWrapper } from "@/test/intl";
import { useSolverErrorText } from "./error-text";

describe("useSolverErrorText", () => {
  it("explains a full app in both languages", () => {
    const id = renderHook(() => useSolverErrorText(), { wrapper: intlWrapper("id") });
    expect(id.result.current("appFull")).toMatch(/Penyimpanan MitraMatika sedang penuh/);
    const en = renderHook(() => useSolverErrorText(), { wrapper: intlWrapper("en") });
    expect(en.result.current("appFull")).toMatch(/MitraMatika storage is full/);
  });

  it("explains the teacher's own full storage in both languages", () => {
    const id = renderHook(() => useSolverErrorText(), { wrapper: intlWrapper("id") });
    expect(id.result.current("quota")).toMatch(/Penyimpanan Anda sudah penuh/);
    const en = renderHook(() => useSolverErrorText(), { wrapper: intlWrapper("en") });
    expect(en.result.current("quota")).toMatch(/Your storage is full/);
  });
});
