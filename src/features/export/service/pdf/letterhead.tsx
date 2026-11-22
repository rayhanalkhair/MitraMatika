// The letterhead: logo, header lines above the school name, and a double rule (print-css.ts).
// A PNG or JPEG logo is decoded here from the model's data URI and drawn from bytes (never a URL:
// the PDF renderer must not fetch). An SVG logo, or one whose header cannot be read, is left out
// with a `logoOmitted` warning, like in Word.
import { Image, View } from "@react-pdf/renderer";
import type { ReactElement } from "react";
import type { ExportDocument } from "../document-model";
import { imageSize } from "../image-size";
import { MM, type PdfContext, type PdfLayout } from "./context";
import { plainText } from "./rich";

const LOGO_PT = 20 * MM;
const RULE = 0.75;

export interface LogoImage {
  data: Buffer;
  format: "png" | "jpg";
}

/** The logo's bytes, or null (with a `logoOmitted` warning) when it cannot be drawn. */
export function logoImage(dataUri: string | null, ctx: PdfContext): LogoImage | null {
  if (dataUri === null || dataUri === "") return null;
  const match = /^data:(image\/(?:png|jpeg|svg\+xml));base64,([A-Za-z0-9+/=]+)$/.exec(
    dataUri,
  );
  const contentType = match?.[1] ?? "unknown";
  const format =
    contentType === "image/png" ? "png" : contentType === "image/jpeg" ? "jpg" : null;
  const data = match !== null && format !== null ? Buffer.from(match[2], "base64") : null;
  if (data === null || format === null || imageSize(data, format) === null) {
    ctx.warnings.push({
      code: "logoOmitted",
      where: { part: "letterhead" },
      source: contentType,
    });
    return null;
  }
  return { data, format };
}

/** The letterhead block, or null when there is neither text nor a logo to show. */
export function letterhead(
  doc: ExportDocument,
  ctx: PdfContext,
  lay: PdfLayout,
): ReactElement | null {
  const { lines, schoolName } = doc.header;
  const logo = logoImage(doc.header.logoDataUri, ctx);
  if (lines.length === 0 && schoolName === "" && logo === null) return null;
  const text = [
    ...lines.map((line, index) =>
      plainText(line.toUpperCase(), lay.font, {
        key: `line-${String(index)}`,
        fontSize: 11,
        bold: true,
        lineHeight: 1.2,
        style: { textAlign: "center" },
      }),
    ),
    ...(schoolName === ""
      ? []
      : [
          plainText(schoolName, lay.font, {
            key: "school",
            fontSize: 14,
            bold: true,
            lineHeight: 1.2,
            style: { textAlign: "center" },
          }),
        ]),
  ];
  return (
    <View key="letterhead">
      <View style={{ flexDirection: "row", alignItems: "center", paddingBottom: 6 }}>
        {logo === null ? (
          <View style={{ width: LOGO_PT }} />
        ) : (
          // React-PDF's Image, not an HTML <img>: it has no alt prop.
          // eslint-disable-next-line jsx-a11y/alt-text
          <Image
            src={logo}
            style={{ width: LOGO_PT, height: LOGO_PT, objectFit: "contain" }}
          />
        )}
        <View style={{ flex: 1, marginHorizontal: 12 }}>{text}</View>
        <View style={{ width: LOGO_PT }} />
      </View>
      {/* The double rule of `border-bottom: 3px double`: two hairlines with a hairline gap. */}
      <View style={{ borderTopWidth: RULE, borderTopColor: "#000000" }} />
      <View
        style={{ borderTopWidth: RULE, borderTopColor: "#000000", marginTop: RULE }}
      />
    </View>
  );
}
