import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import {
  isOwnLogoKey,
  logoKey,
  MAX_LOGO_BYTES,
  MAX_LOGO_SIDE,
  sanitizeSvg,
  validateLogo,
} from "./logo";

const encoder = new TextEncoder();
const svgBytes = (text: string) => encoder.encode(text);

function image(format: "png" | "jpeg", width = 8, height = 8): Uint8Array {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#3730a3";
  context.fillRect(0, 0, width, height);
  return new Uint8Array(
    format === "png" ? canvas.encodeSync("png") : canvas.encodeSync("jpeg"),
  );
}

// A PNG whose header claims a huge size; only the first chunk matters for the check.
function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  bytes.set(encoder.encode("IHDR"), 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([8, 6, 0, 0, 0], 24);
  return bytes;
}

// A Windows executable starts with "MZ"; its name or declared type says nothing.
const EXE = new Uint8Array([
  0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0, 4, 0, 0, 0, 0xff, 0xff, 0, 0,
]);

const SVG_NS = 'xmlns="http://www.w3.org/2000/svg"';

describe("validateLogo: magic bytes decide", () => {
  it("accepts a PNG and a JPEG by their bytes", async () => {
    const png = await validateLogo(image("png"), "image/png");
    expect(png).toMatchObject({
      ok: true,
      data: { ext: "png", contentType: "image/png" },
    });
    const jpg = await validateLogo(image("jpeg"), "image/jpeg");
    expect(jpg).toMatchObject({
      ok: true,
      data: { ext: "jpg", contentType: "image/jpeg" },
    });
  });

  it("accepts a PNG declared as a JPEG and stores it as what it really is", async () => {
    const result = await validateLogo(image("png"), "image/jpeg");
    expect(result).toMatchObject({
      ok: true,
      data: { ext: "png", contentType: "image/png" },
    });
  });

  it("rejects an executable renamed .png, whatever type the browser declared", async () => {
    expect(await validateLogo(EXE, "image/png")).toEqual({
      ok: false,
      error: "unsupportedType",
    });
    expect(await validateLogo(EXE, "image/svg+xml")).toEqual({
      ok: false,
      error: "unsupportedType",
    });
  });

  it("rejects other image formats and plain text", async () => {
    const gif = encoder.encode("GIF89a\u0001\u0000\u0001\u0000\u0000\u0000\u0000");
    expect(await validateLogo(gif, "image/gif")).toEqual({
      ok: false,
      error: "unsupportedType",
    });
    expect(await validateLogo(encoder.encode("hello, world"), "image/png")).toEqual({
      ok: false,
      error: "unsupportedType",
    });
  });

  it("rejects an empty file and anything above 1 MB, by one byte", async () => {
    expect(await validateLogo(new Uint8Array(0), "image/png")).toEqual({
      ok: false,
      error: "empty",
    });
    const tooBig = new Uint8Array(MAX_LOGO_BYTES + 1);
    tooBig.set(image("png"));
    expect(MAX_LOGO_BYTES).toBe(1024 * 1024);
    expect(await validateLogo(tooBig, "image/png")).toEqual({
      ok: false,
      error: "tooLarge",
    });
  });

  it("rejects a raster whose header claims more than the side limit", async () => {
    expect(await validateLogo(pngHeader(MAX_LOGO_SIDE + 1, 10), "image/png")).toEqual({
      ok: false,
      error: "dimensionsTooLarge",
    });
    expect(await validateLogo(image("jpeg", 10, 10), "image/jpeg")).toMatchObject({
      ok: true,
    });
  });

  it("accepts an SVG (with or without an XML declaration) and stores the sanitised copy", async () => {
    const result = await validateLogo(
      svgBytes(
        `<?xml version="1.0" encoding="UTF-8"?>\n<svg ${SVG_NS} viewBox="0 0 10 10"><script>alert(1)</script><circle cx="5" cy="5" r="4" fill="#3730a3"/></svg>`,
      ),
      "image/svg+xml",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({ ext: "svg", contentType: "image/svg+xml" });
    const text = new TextDecoder().decode(result.data.bytes);
    expect(text).not.toContain("script");
    expect(text).toContain("<circle");
  });

  it("rejects HTML and XML that is not an SVG", async () => {
    for (const text of [
      "<html><body><script>alert(1)</script></body></html>",
      '<?xml version="1.0"?><note>hi</note>',
      `<svg ${SVG_NS}><unclosed></svg>`,
    ]) {
      expect(await validateLogo(svgBytes(text), "image/svg+xml"), text).toEqual({
        ok: false,
        error: "invalidImage",
      });
    }
  });
});

describe("sanitizeSvg: an allowlist rebuild", () => {
  const clean = (body: string, attributes = "") => {
    const result = sanitizeSvg(`<svg ${SVG_NS}${attributes}>${body}</svg>`);
    if (!result.ok) throw new Error(`rejected: ${result.error}`);
    return result.data;
  };

  it("keeps shapes, groups, gradients and text with their safe attributes", () => {
    const out = clean(
      '<defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs><g transform="translate(1 1)"><path d="M0 0L10 10" stroke="#000" stroke-width="2" fill="url(#g)"/><text x="1" y="9" font-size="4">SMP &amp; &lt;2&gt;</text></g>',
      ' viewBox="0 0 10 10" width="40" height="40"',
    );
    expect(out).toContain('viewBox="0 0 10 10"');
    expect(out).toContain(
      '<path d="M0 0L10 10" stroke="#000" stroke-width="2" fill="url(#g)"/>',
    );
    expect(out).toContain('<stop offset="0" stop-color="#fff"/>');
    expect(out).toContain("SMP &amp; &lt;2&gt;");
    expect(out.startsWith(`<svg ${SVG_NS}`)).toBe(true);
  });

  it("drops <script> with its content, wherever it is", () => {
    const out = clean(
      '<script>alert(1)</script><g><script type="text/javascript"><![CDATA[alert(2)]]></script><rect width="1" height="1"/></g>',
    );
    expect(out).not.toMatch(/script|alert/);
    expect(out).toContain("<rect");
  });

  it("drops every event handler, onload on the root too", () => {
    const out = clean(
      '<rect width="1" height="1" onclick="alert(1)" ONMOUSEOVER="alert(2)"/>',
      ' onload="alert(3)"',
    );
    expect(out).not.toMatch(/on\w+=|alert/i);
  });

  it("drops javascript: and external hrefs, keeps internal fragment references", () => {
    const out = clean(
      '<defs><circle id="c" r="1"/></defs><use href="#c"/><use xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="javascript:alert(1)"/><use href="https://evil.example/x.svg#c"/><a href="javascript:alert(2)"><rect width="1" height="1"/></a>',
    );
    expect(out).toContain('<use href="#c"/>');
    expect(out).not.toMatch(/javascript|evil\.example|<a[\s>]/);
  });

  it("drops <image> with an external or data href, <foreignObject>, <style> and animations", () => {
    const out = clean(
      '<image href="https://tracker.example/pixel.png" width="1" height="1"/><image href="data:image/svg+xml;base64,PHN2Zz4=" width="1" height="1"/><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><iframe src="https://evil.example"/></div></foreignObject><style>@import url(https://evil.example/x.css);</style><set attributeName="href" to="javascript:alert(1)"/><animate attributeName="href" values="javascript:alert(1)"/><circle r="1"/>',
    );
    expect(out).not.toMatch(
      /image|tracker|data:|foreignObject|iframe|evil|style|@import|<set|animate/,
    );
    expect(out).toContain('<circle r="1"/>');
  });

  it("drops style attributes and url() values that point outside the document", () => {
    const out = clean(
      '<rect width="1" height="1" style="fill:url(https://evil.example/a)" fill="url(https://evil.example/b)" stroke="url(#ok)"/>',
    );
    expect(out).not.toMatch(/style=|evil/);
    expect(out).toContain('stroke="url(#ok)"');
  });

  it("rejects a DOCTYPE, so no entity can expand (billion laughs, XXE)", () => {
    const bomb = `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">]><svg ${SVG_NS}><text>&c;</text></svg>`;
    expect(sanitizeSvg(bomb)).toEqual({ ok: false, error: "invalidImage" });
    const xxe = `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg ${SVG_NS}><text>&x;</text></svg>`;
    expect(sanitizeSvg(xxe)).toEqual({ ok: false, error: "invalidImage" });
  });

  it("rejects a root that is not an svg, broken XML and an unknown entity", () => {
    expect(sanitizeSvg("<g/>")).toEqual({ ok: false, error: "invalidImage" });
    expect(sanitizeSvg(`<svg ${SVG_NS}><g></svg>`)).toEqual({
      ok: false,
      error: "invalidImage",
    });
    expect(sanitizeSvg(`<svg ${SVG_NS}><text>&nbsp;</text></svg>`)).toEqual({
      ok: false,
      error: "invalidImage",
    });
  });

  it("caps the element count and the nesting depth", () => {
    const many = `<svg ${SVG_NS}>${'<rect width="1" height="1"/>'.repeat(5001)}</svg>`;
    expect(sanitizeSvg(many)).toEqual({ ok: false, error: "invalidImage" });
    const deep = `<svg ${SVG_NS}>${"<g>".repeat(101)}${"</g>".repeat(101)}</svg>`;
    expect(sanitizeSvg(deep)).toEqual({ ok: false, error: "invalidImage" });
  });

  it("drops comments and processing instructions, and elements of other namespaces", () => {
    const out = clean(
      '<!-- <script>alert(1)</script> --><?php echo 1; ?><x:script xmlns:x="http://www.w3.org/1999/xhtml">alert(1)</x:script><circle r="1"/>',
    );
    expect(out).toBe(`<svg ${SVG_NS}><circle r="1"/></svg>`);
  });
});

describe("logoKey", () => {
  it("is built from ids only", () => {
    expect(
      logoKey(
        "11111111-1111-1111-1111-111111111111",
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "svg",
      ),
    ).toBe(
      "templates/11111111-1111-1111-1111-111111111111/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/logo.svg",
    );
    expect(() => logoKey("guru@example.test", "t", "png")).toThrow();
  });
});

describe("isOwnLogoKey", () => {
  const OWNER = "11111111-1111-1111-1111-111111111111";
  const TEMPLATE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  it("accepts only keys under the template's own prefix", () => {
    expect(isOwnLogoKey(OWNER, TEMPLATE, logoKey(OWNER, TEMPLATE, "png"))).toBe(true);
    for (const key of [
      `templates/22222222-2222-2222-2222-222222222222/${TEMPLATE}/logo.png`,
      `templates/${OWNER}/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/logo.png`,
      `templates/${OWNER}/${TEMPLATE}/../../other/logo.png`,
      `templates/${OWNER}/${TEMPLATE}`,
      `exports/${OWNER}/${TEMPLATE}/logo.png`,
    ]) {
      expect(isOwnLogoKey(OWNER, TEMPLATE, key), key).toBe(false);
    }
  });
});
