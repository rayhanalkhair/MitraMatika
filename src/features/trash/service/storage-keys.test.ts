import { describe, expect, it } from "vitest";
import { EXPORT_JOB_TYPE, exportPrefix } from "@/features/export";
import { SOLVER_JOB_TYPES as SOLVER_JOBS, sessionPrefix } from "@/features/solver";
import { logoKey } from "@/features/templates";
import {
  exportRunPrefix,
  isOwnExportKey,
  RENDER_EXPORT_JOB_TYPE,
  SOLVER_JOB_TYPES,
  solverSessionPrefix,
  templatePrefix,
} from "./storage-keys";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ID = "33333333-3333-4333-8333-333333333333";

describe("the trash's storage prefixes", () => {
  it("are the layouts the export job and the logo upload write", () => {
    expect(exportRunPrefix(OWNER, ID)).toBe(exportPrefix(OWNER, ID));
    expect(logoKey(OWNER, ID, "png").startsWith(templatePrefix(OWNER, ID))).toBe(true);
    expect(RENDER_EXPORT_JOB_TYPE).toBe(EXPORT_JOB_TYPE);
    expect(solverSessionPrefix(OWNER, ID)).toBe(sessionPrefix(OWNER, ID));
    expect(SOLVER_JOB_TYPES).toEqual([...SOLVER_JOBS]);
  });

  it("never build an empty, partial or path-escaping prefix", () => {
    for (const [owner, id] of [
      ["", ID],
      [OWNER, ""],
      ["..", ID],
      [OWNER, "../x"],
      [`${OWNER}/x`, ID],
    ]) {
      expect(() => exportRunPrefix(owner, id)).toThrow();
      expect(() => templatePrefix(owner, id)).toThrow();
      expect(() => solverSessionPrefix(owner, id)).toThrow();
    }
    expect(templatePrefix(OWNER.toUpperCase(), ID)).toBe(`templates/${OWNER}/${ID}/`);
  });

  it("accept an export key only under the owner's own prefix", () => {
    expect(isOwnExportKey(OWNER, `exports/${OWNER}/${ID}/paper.pdf`)).toBe(true);
    expect(isOwnExportKey(OWNER, `exports/${OTHER}/${ID}/paper.pdf`)).toBe(false);
    expect(isOwnExportKey(OWNER, `exports/${OWNER}/../${OTHER}/paper.pdf`)).toBe(false);
    expect(isOwnExportKey(OWNER, `templates/${OWNER}/${ID}/logo.png`)).toBe(false);
    expect(isOwnExportKey("", `exports//x`)).toBe(false);
  });
});
