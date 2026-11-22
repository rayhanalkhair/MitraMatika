// The answer key: a bordered table No / Jawaban / Skor with a Total row (render-html.ts is the model).
import { View } from "@react-pdf/renderer";
import type { ReactElement } from "react";
import { keyRows, type ExportDocument } from "../document-model";
import { formatPoints } from "../render-html";
import type { PdfLayout } from "./context";
import { plainText } from "./rich";

const BORDER = 0.75;
const COLUMNS = [0.25, 0.4, 0.35] as const;

export function keyTable(doc: ExportDocument, lay: PdfLayout): ReactElement {
  const rows = keyRows(doc);
  const total = rows.reduce((sum, row) => sum + Math.round(row.points * 100), 0) / 100;
  const tableWidth = lay.contentWidth * 0.7;
  const [no, answer, score] = COLUMNS.map((share) => tableWidth * share);
  const cell = (text: string, width: number, key: string, bold = false): ReactElement => (
    <View
      key={key}
      style={{
        width,
        paddingVertical: 3,
        paddingHorizontal: 10,
        borderRightWidth: BORDER,
        borderBottomWidth: BORDER,
        borderColor: "#000000",
      }}
    >
      {plainText(text, lay.font, { bold, style: { textAlign: "center" } })}
    </View>
  );
  const line = (cells: ReactElement[], key: string): ReactElement => (
    <View key={key} wrap={false} style={{ flexDirection: "row" }}>
      {cells}
    </View>
  );
  return (
    <View
      key="key-table"
      style={{
        alignSelf: "center",
        marginVertical: 10,
        width: tableWidth,
        borderLeftWidth: BORDER,
        borderTopWidth: BORDER,
        borderColor: "#000000",
      }}
    >
      {line(
        [
          cell("No", no, "no", true),
          cell("Jawaban", answer, "answer", true),
          cell("Skor", score, "score", true),
        ],
        "head",
      )}
      {rows.map((row) =>
        line(
          [
            cell(String(row.number), no, "no"),
            cell(row.answer, answer, "answer"),
            cell(formatPoints(row.points), score, "score"),
          ],
          `row-${String(row.number)}`,
        ),
      )}
      {line(
        [
          cell("Total", no + answer, "total", true),
          cell(formatPoints(total), score, "sum", true),
        ],
        "total",
      )}
    </View>
  );
}
