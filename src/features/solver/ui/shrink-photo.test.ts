// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_SOLVER_PHOTO_BYTES } from "../schema/solver";
import { shrinkPhoto } from "./shrink-photo";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function stubCanvas(blobSize: number) {
  const sizes: [number, number][] = [];
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
    this: HTMLCanvasElement,
  ) {
    sizes.push([this.width, this.height]);
    return { drawImage: vi.fn() } as unknown as CanvasRenderingContext2D;
  } as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
    callback(new Blob([new Uint8Array(blobSize)], { type: "image/jpeg" }));
  });
  return sizes;
}

describe("shrinkPhoto", () => {
  it("redraws every photo (its metadata and orientation are baked in), even a small one", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(() => Promise.resolve({ width: 800, height: 600, close: vi.fn() })),
    );
    const sizes = stubCanvas(1_000);
    const file = new File([new Uint8Array(5_000)], "IMG_0001.jpg", {
      type: "image/jpeg",
    });
    const out = await shrinkPhoto(file);
    expect(out).not.toBe(file);
    expect(out?.type).toBe("image/jpeg");
    expect(out?.size).toBe(1_000);
    expect(sizes).toEqual([[800, 600]]);
  });

  it("scales a photo over the pixel limit down, even when its bytes are small", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(() => Promise.resolve({ width: 8_000, height: 6_000, close: vi.fn() })),
    );
    const sizes = stubCanvas(900_000);
    const out = await shrinkPhoto(
      new File([new Uint8Array(1_000_000)], "a.jpg", { type: "image/jpeg" }),
    );
    expect(out?.size).toBe(900_000);
    expect(Math.max(...sizes[0])).toBeLessThanOrEqual(2_000);
  });

  it("falls back to the file itself when the browser cannot redraw it, if it fits", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(() => Promise.reject(new Error("unsupported"))),
    );
    const small = new File([new Uint8Array(10)], "a.png", { type: "image/png" });
    expect(await shrinkPhoto(small)).toBe(small);
    const large = new File([new Uint8Array(MAX_SOLVER_PHOTO_BYTES + 1)], "b.jpg", {
      type: "image/jpeg",
    });
    expect(await shrinkPhoto(large)).toBeNull();
  });
});
