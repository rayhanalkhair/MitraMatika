// The paper: title block, student fields, instructions box, sections and numbered questions with
// their options in 1, 2 or 4 columns (render-html.ts is the model).
import { Text, View } from "@react-pdf/renderer";
import type { ReactElement } from "react";
import type { ExportDocument, ExportItem } from "../document-model";
import { DOCUMENT_TITLES, type DocumentKind } from "../render-html";
import { pdfFontFamily } from "./fonts";
import type { PdfContext, PdfLayout } from "./context";
import { plainText, richText } from "./rich";
import {
  BODY_PT,
  HEADING_MIN_PRESENCE,
  ITEM_GAP,
  LABEL_GAP,
  LABEL_WIDTH,
  NUMBER_COLUMN,
  NUMBER_GAP,
  NUMBER_WIDTH,
  OPTION_GAP,
  PARAGRAPH_GAP,
  WHOLE_ITEM_SHARE,
  LINE_HEIGHT,
  textStyle,
} from "./styles";

/** An item is laid out whole on one page when its estimate fits 90 % of a page (spike S4). */
export function keepsWhole(estimatePt: number, lay: PdfLayout): boolean {
  return estimatePt <= WHOLE_ITEM_SHARE * lay.contentHeight;
}

export function titleBlock(
  doc: ExportDocument,
  kind: DocumentKind,
  lay: PdfLayout,
): ReactElement {
  const { meta } = doc;
  const rows: [string, string][] = [
    ["Mata pelajaran", meta.subject],
    ["Kelas", String(meta.grade)],
  ];
  if (meta.examDate !== null && meta.examDate !== "") {
    rows.push(["Hari, tanggal", meta.examDate]);
  }
  if (meta.durationMinutes !== null) {
    rows.push(["Waktu", `${String(meta.durationMinutes)} menit`]);
  }
  return (
    <View key="title">
      {plainText(DOCUMENT_TITLES[kind].toUpperCase(), lay.font, {
        fontSize: 14,
        bold: true,
        style: { textAlign: "center", marginTop: 12, marginBottom: 2 },
      })}
      {plainText(`${meta.title} (${meta.kindLabel})`, lay.font, {
        style: { textAlign: "center", marginBottom: 8 },
      })}
      <View style={{ marginBottom: 8 }}>
        {rows.map(([label, value]) => (
          <View key={label} style={{ flexDirection: "row" }}>
            <Text style={textStyle(pdfFontFamily(lay.font), BODY_PT, { width: 96 })}>
              {label}
            </Text>
            {plainText(`: ${value}`, lay.font, { style: { flexShrink: 1 } })}
          </View>
        ))}
      </View>
    </View>
  );
}

/** "Nama", "Kelas" ... each followed by a dotted line to write on, two to a row. */
export function studentBlock(doc: ExportDocument, lay: PdfLayout): ReactElement | null {
  if (doc.studentFields.length === 0) return null;
  const half = (lay.contentWidth - 18) / 2;
  return (
    <View
      key="student"
      style={{ flexDirection: "row", flexWrap: "wrap", marginVertical: 8 }}
    >
      {doc.studentFields.map(({ key, label }, index) => (
        <View
          key={key}
          style={{
            width: half,
            flexDirection: "row",
            alignItems: "flex-end",
            marginBottom: 6,
            marginRight: index % 2 === 0 ? 18 : 0,
          }}
        >
          <Text style={textStyle(pdfFontFamily(lay.font))}>{label}</Text>
          <View
            style={{
              flexGrow: 1,
              marginLeft: 6,
              height: BODY_PT * LINE_HEIGHT,
              borderBottomWidth: 0.75,
              borderBottomStyle: "dotted",
              borderBottomColor: "#000000",
            }}
          />
        </View>
      ))}
    </View>
  );
}

/** The "Petunjuk:" box. */
export function instructionsBox(
  md: string,
  ctx: PdfContext,
  lay: PdfLayout,
): ReactElement {
  ctx.where = { part: "instructions" };
  const rich = richText(md, ctx, { font: lay.font, widthPt: lay.contentWidth - 18 });
  return (
    <View
      key="instructions"
      style={{
        borderWidth: 0.75,
        borderColor: "#000000",
        padding: 4,
        paddingHorizontal: 8,
        marginVertical: 8,
      }}
    >
      {plainText("Petunjuk:", lay.font, { bold: true })}
      {rich.nodes}
    </View>
  );
}

/** A section's heading (kept with the first lines after it) and its instructions. */
export function sectionHeading(
  section: ExportDocument["sections"][number],
  index: number,
  ctx: PdfContext,
  lay: PdfLayout,
): { nodes: ReactElement[]; heightPt: number } {
  let heightPt = 14 + 3 + BODY_PT * LINE_HEIGHT;
  const nodes: ReactElement[] = [
    plainText(section.title, lay.font, {
      key: `heading-${String(index)}`,
      bold: true,
      minPresenceAhead: HEADING_MIN_PRESENCE,
      style: { marginTop: 14, marginBottom: 3 },
    }),
  ];
  if (section.instructionsMd !== null && section.instructionsMd !== "") {
    ctx.where = { part: "sectionInstructions", section: section.title };
    const rich = richText(section.instructionsMd, ctx, {
      font: lay.font,
      widthPt: lay.contentWidth,
      italic: true,
    });
    nodes.push(<View key={`instructions-${String(index)}`}>{rich.nodes}</View>);
    heightPt += rich.heightPt;
  }
  return { nodes, heightPt };
}

/** An item's element and its estimated height (the document splits very long flows by it). */
export interface PlacedItem {
  node: ReactElement;
  heightPt: number;
}

/** The number in its column, then the item's body. */
export function itemShell(
  item: ExportItem,
  body: ReactElement[],
  contentHeightPt: number,
  lay: PdfLayout,
): PlacedItem {
  const heightPt = contentHeightPt + ITEM_GAP;
  const whole = keepsWhole(heightPt, lay);
  const node = (
    <View
      key={item.itemId}
      id={`q-${String(item.number)}`}
      // Never `wrap={undefined}`: React-PDF reads a present prop as the answer "no".
      {...(whole ? { wrap: false } : {})}
      style={{ flexDirection: "row", marginBottom: ITEM_GAP }}
    >
      <Text
        style={textStyle(pdfFontFamily(lay.font), BODY_PT, {
          width: NUMBER_WIDTH,
          textAlign: "right",
          marginRight: NUMBER_GAP,
        })}
      >{`${String(item.number)}.`}</Text>
      <View style={{ flexGrow: 1, flexShrink: 1 }}>{body}</View>
    </View>
  );
  return { node, heightPt };
}

/** The width left for an item's text after its number column. */
export const bodyWidth = (lay: PdfLayout): number => lay.contentWidth - NUMBER_COLUMN;

function optionRows(
  item: ExportItem,
  ctx: PdfContext,
  lay: PdfLayout,
): { nodes: ReactElement[]; heightPt: number } {
  const options = item.options ?? [];
  const columns = item.columns;
  const cell = (bodyWidth(lay) - OPTION_GAP * (columns - 1)) / columns;
  const textWidth = cell - LABEL_WIDTH - LABEL_GAP;
  const rows: ReactElement[] = [];
  let heightPt = 0;
  for (let from = 0; from < options.length; from += columns) {
    const group = options.slice(from, from + columns);
    let rowHeight = 0;
    const cells = group.map((option, index) => {
      ctx.where = { part: "option", number: item.number, label: option.label };
      const rich = richText(option.textMd, ctx, {
        font: lay.font,
        widthPt: textWidth,
        inline: true,
      });
      rowHeight = Math.max(rowHeight, rich.heightPt);
      return (
        <View
          key={option.label}
          style={{
            width: cell,
            flexDirection: "row",
            marginRight: index < columns - 1 ? OPTION_GAP : 0,
          }}
        >
          <Text
            style={textStyle(pdfFontFamily(lay.font), BODY_PT, {
              width: LABEL_WIDTH,
              marginRight: LABEL_GAP,
            })}
          >{`${option.label}.`}</Text>
          <View style={{ width: textWidth }}>{rich.nodes}</View>
        </View>
      );
    });
    rows.push(
      <View
        key={`row-${String(from)}`}
        wrap={false}
        style={{ flexDirection: "row", marginBottom: 2 }}
      >
        {cells}
      </View>,
    );
    heightPt += Math.max(rowHeight, BODY_PT * LINE_HEIGHT) + 2;
  }
  return { nodes: rows, heightPt };
}

/** One numbered question: stem, then its options. */
export function paperItem(item: ExportItem, ctx: PdfContext, lay: PdfLayout): PlacedItem {
  ctx.where = { part: "stem", number: item.number };
  const stem = richText(item.stemMd, ctx, { font: lay.font, widthPt: bodyWidth(lay) });
  const body: ReactElement[] = [<View key="stem">{stem.nodes}</View>];
  let heightPt = stem.heightPt;
  if (item.options !== undefined && item.options.length > 0) {
    const options = optionRows(item, ctx, lay);
    body.push(
      <View key="options" style={{ marginTop: PARAGRAPH_GAP }}>
        {options.nodes}
      </View>,
    );
    heightPt += options.heightPt + PARAGRAPH_GAP;
  }
  return itemShell(item, body, heightPt, lay);
}
