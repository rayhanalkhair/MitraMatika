// The solutions: each question with "Jawaban: X. <option text>" and its numbered steps.
import { Text, View } from "@react-pdf/renderer";
import type { ReactElement } from "react";
import type { ExportItem } from "../document-model";
import { parseRich, type RichBlock } from "../rich-blocks";
import type { PdfContext, PdfLayout } from "./context";
import { pdfFontFamily } from "./fonts";
import { bodyWidth, itemShell, type PlacedItem } from "./paper";
import { richBlocks, richText } from "./rich";
import { BODY_PT, STEP_INDENT, textStyle } from "./styles";

/** "Jawaban: B." and the text of the correct option, as one bold paragraph. */
function answerBlocks(item: ExportItem, ctx: PdfContext): RichBlock[] {
  const correct = item.options?.find((option) => option.label === item.answerMd);
  const lead: RichBlock = {
    kind: "paragraph",
    runs: [
      {
        kind: "text",
        text: `Jawaban: ${item.answerMd}${correct === undefined ? "" : ". "}`,
        bold: true,
        italic: false,
        sup: false,
      },
    ],
  };
  if (correct === undefined) return [lead];
  ctx.where = { part: "option", number: item.number, label: correct.label };
  const first = parseRich(correct.textMd, true).at(0);
  if (first?.kind !== "paragraph") return [lead];
  return [{ kind: "paragraph", runs: [...lead.runs, ...first.runs] }];
}

export function solutionItem(
  item: ExportItem,
  ctx: PdfContext,
  lay: PdfLayout,
): PlacedItem {
  const width = bodyWidth(lay);
  ctx.where = { part: "stem", number: item.number };
  const stem = richText(item.stemMd, ctx, { font: lay.font, widthPt: width });
  const answer = richBlocks(answerBlocks(item, ctx), ctx, {
    font: lay.font,
    widthPt: width,
    bold: true,
    inline: true,
  });
  const body: ReactElement[] = [
    <View key="stem">{stem.nodes}</View>,
    <View key="answer" style={{ marginVertical: 2 }}>
      {answer.nodes}
    </View>,
  ];
  let heightPt = stem.heightPt + answer.heightPt + 4;
  const stepWidth = width - STEP_INDENT;
  item.steps.forEach((step, index) => {
    ctx.where = { part: "step", number: item.number, step: index + 1 };
    const rich = richText(step, ctx, {
      font: lay.font,
      widthPt: stepWidth,
      inline: true,
    });
    heightPt += rich.heightPt + 2;
    body.push(
      <View
        key={`step-${String(index)}`}
        style={{ flexDirection: "row", marginBottom: 2 }}
      >
        <Text
          style={textStyle(pdfFontFamily(lay.font), BODY_PT, {
            width: STEP_INDENT - 4,
            textAlign: "right",
            marginRight: 4,
            marginTop: rich.firstLineLiftPt,
          })}
        >{`${String(index + 1)}.`}</Text>
        <View style={{ width: stepWidth }}>{rich.nodes}</View>
      </View>,
    );
  });
  return itemShell(item, body, heightPt, lay, stem.firstLineLiftPt);
}
