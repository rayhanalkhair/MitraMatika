// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithIntl } from "@/test/intl";
import type { ReviewQuestion } from "@/features/review/service/review";
import { DecisionBar } from "./DecisionBar";

afterEach(cleanup);

const make = (
  over: Record<string, unknown> = {},
  status = "terverifikasi",
  verification: Record<string, unknown> = {},
) =>
  ({
    decision: "draft",
    override: false,
    banked: false,
    ...over,
    verification: {
      status,
      regenerated: false,
      regenerationFailed: false,
      ...verification,
    },
  }) as unknown as ReviewQuestion;

function renderBar(
  question: ReviewQuestion,
  extra: Partial<Parameters<typeof DecisionBar>[0]> = {},
) {
  const onDecide = vi.fn();
  renderWithIntl(
    <DecisionBar
      question={question}
      displayStatus="terverifikasi"
      jobState="finished"
      onDecide={onDecide}
      error={null}
      pending={false}
      {...extra}
    />,
  );
  return onDecide;
}

describe("DecisionBar", () => {
  it("shows Setujui and Tolak for a draft and decides directly", () => {
    const onDecide = renderBar(make());
    fireEvent.click(screen.getByRole("button", { name: "Setujui" }));
    expect(onDecide).toHaveBeenLastCalledWith("approve");
    fireEvent.click(screen.getByRole("button", { name: "Tolak" }));
    expect(onDecide).toHaveBeenLastCalledWith("reject");
    expect(screen.queryByRole("button", { name: "Batalkan keputusan" })).toBeNull();
  });

  it("offers 'Setujui dengan catatan' for a contradiction and opens the dialog instead of deciding", () => {
    const onDecide = renderBar(make({}, "ketidaksesuaian"), {
      displayStatus: "ketidaksesuaian",
    });
    expect(screen.queryByRole("button", { name: "Setujui" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Setujui dengan catatan" }));
    expect(onDecide).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("sends the trimmed note from the dialog with the approve action", () => {
    const onDecide = renderBar(make({}, "ketidaksesuaian"), {
      displayStatus: "ketidaksesuaian",
    });
    fireEvent.click(screen.getByRole("button", { name: "Setujui dengan catatan" }));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "  Sudah saya hitung ulang.  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Setujui soal ini" }));
    expect(onDecide).toHaveBeenCalledWith("approve", "Sudah saya hitung ulang.");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows an approved line and the undo button", () => {
    const onDecide = renderBar(make({ decision: "approved" }));
    expect(screen.getByText("Disetujui")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Setujui" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Batalkan keputusan" }));
    expect(onDecide).toHaveBeenCalledWith("reset");
  });

  it("says 'Disetujui dengan catatan' when approved by override", () => {
    renderBar(make({ decision: "approved", override: true }, "ketidaksesuaian"));
    expect(screen.getByText("Disetujui dengan catatan")).toBeTruthy();
    expect(screen.queryByText("Disetujui")).toBeNull();
  });

  it("shows a rejected line and the undo button", () => {
    renderBar(make({ decision: "rejected" }));
    expect(screen.getByText("Ditolak")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Batalkan keputusan" })).toBeTruthy();
  });

  it("disables Setujui with visible waiting text while checking or waiting; Tolak still works", () => {
    for (const displayStatus of ["checking", "waiting"] as const) {
      const onDecide = renderBar(make(), { displayStatus });
      const waiting = screen.getByRole<HTMLButtonElement>("button", {
        name: "Menunggu pemeriksaan selesai",
      });
      expect(waiting.disabled).toBe(true);
      expect(screen.queryByRole("button", { name: "Setujui" })).toBeNull();
      const reject = screen.getByRole<HTMLButtonElement>("button", { name: "Tolak" });
      expect(reject.disabled).toBe(false);
      fireEvent.click(reject);
      expect(onDecide).toHaveBeenCalledWith("reject");
      cleanup();
    }
  });

  it("never disables undo because of checks", () => {
    renderBar(make({ decision: "rejected" }), { displayStatus: "checking" });
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Batalkan keputusan" })
        .disabled,
    ).toBe(false);
  });

  it("disables every button while pending", () => {
    renderBar(make(), { pending: true });
    for (const button of screen.getAllByRole("button")) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("makes every button at least 44 px", () => {
    renderBar(make());
    for (const button of screen.getAllByRole("button")) {
      expect(button.className).toMatch(/min-h-11/);
      expect(button.className).toMatch(/min-w-11/);
    }
  });

  it("shows the error with role=alert", () => {
    renderBar(make(), { error: "Keputusan belum tersimpan. Coba lagi." });
    expect(screen.getByRole("alert").textContent).toBe(
      "Keputusan belum tersimpan. Coba lagi.",
    );
  });

  it("renders no alert without an error", () => {
    renderBar(make());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  describe("a first-version contradiction while the job runs", () => {
    const contradiction = (verification: Record<string, unknown> = {}) =>
      make({}, "ketidaksesuaian", verification);

    it("waits for the pipeline: Setujui is disabled with the waiting text", () => {
      const onDecide = renderBar(contradiction(), {
        displayStatus: "ketidaksesuaian",
        jobState: "running",
      });
      expect(
        screen.getByRole<HTMLButtonElement>("button", {
          name: "Menunggu pemeriksaan selesai",
        }).disabled,
      ).toBe(true);
      expect(screen.queryByRole("button", { name: "Setujui dengan catatan" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Tolak" }));
      expect(onDecide).toHaveBeenCalledWith("reject");
    });

    it("is offered once the job finished", () => {
      renderBar(contradiction(), {
        displayStatus: "ketidaksesuaian",
        jobState: "finished",
      });
      expect(screen.getByRole("button", { name: "Setujui dengan catatan" })).toBeTruthy();
    });

    it.each([{ regenerated: true }, { regenerationFailed: true }])(
      "is offered while the job runs when the regeneration already happened (%o)",
      (verification) => {
        renderBar(contradiction(verification), {
          displayStatus: "ketidaksesuaian",
          jobState: "running",
        });
        expect(
          screen.getByRole("button", { name: "Setujui dengan catatan" }),
        ).toBeTruthy();
      },
    );
  });

  describe("status announcement and focus", () => {
    it("wraps the decision line in a polite status region", () => {
      renderBar(make({ decision: "approved" }));
      expect(screen.getByRole("status").textContent).toBe("Disetujui");
    });

    function Harness({ start }: { start: "draft" | "approved" | "rejected" }) {
      const [decision, setDecision] = useState(start);
      return (
        <DecisionBar
          question={make({ decision })}
          displayStatus="terverifikasi"
          jobState="finished"
          onDecide={(action) => {
            setDecision(
              action === "approve"
                ? "approved"
                : action === "reject"
                  ? "rejected"
                  : "draft",
            );
          }}
          error={null}
          pending={false}
        />
      );
    }

    it("moves focus to Batalkan keputusan after approve, and to Setujui after undo", async () => {
      renderWithIntl(<Harness start="draft" />);
      fireEvent.click(screen.getByRole("button", { name: "Setujui" }));
      await waitFor(() => {
        expect(document.activeElement).toBe(
          screen.getByRole("button", { name: "Batalkan keputusan" }),
        );
      });
      fireEvent.click(screen.getByRole("button", { name: "Batalkan keputusan" }));
      await waitFor(() => {
        expect(document.activeElement).toBe(
          screen.getByRole("button", { name: "Setujui" }),
        );
      });
    });

    it("moves focus to Batalkan keputusan after reject", async () => {
      renderWithIntl(<Harness start="draft" />);
      fireEvent.click(screen.getByRole("button", { name: "Tolak" }));
      await waitFor(() => {
        expect(document.activeElement).toBe(
          screen.getByRole("button", { name: "Batalkan keputusan" }),
        );
      });
    });

    it("returns focus to the opening button when the override dialog is cancelled", async () => {
      renderBar(make({}, "ketidaksesuaian"), { displayStatus: "ketidaksesuaian" });
      const opener = screen.getByRole("button", { name: "Setujui dengan catatan" });
      opener.focus();
      fireEvent.click(opener);
      fireEvent.click(screen.getByRole("button", { name: "Batal" }));
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).toBeNull();
      });
      await waitFor(() => {
        expect(document.activeElement).toBe(opener);
      });
    });

    it("focuses Batalkan keputusan after the override dialog is confirmed", async () => {
      function OverrideHarness() {
        const [decision, setDecision] = useState<"draft" | "approved">("draft");
        return (
          <DecisionBar
            question={make(
              { decision, override: decision === "approved" },
              "ketidaksesuaian",
            )}
            displayStatus="ketidaksesuaian"
            jobState="finished"
            onDecide={() => {
              setDecision("approved");
            }}
            error={null}
            pending={false}
          />
        );
      }
      renderWithIntl(<OverrideHarness />);
      const opener = screen.getByRole("button", { name: "Setujui dengan catatan" });
      opener.focus();
      fireEvent.click(opener);
      fireEvent.click(screen.getByRole("checkbox"));
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "Sudah saya periksa dengan teliti." },
      });
      fireEvent.click(screen.getByRole("button", { name: "Setujui soal ini" }));
      await waitFor(() => {
        expect(document.activeElement).toBe(
          screen.getByRole("button", { name: "Batalkan keputusan" }),
        );
      });
    });
  });

  it("shows an icon and 'Tersimpan di Bank Soal' with no buttons for a banked question", () => {
    const { container } = renderWithIntl(
      <DecisionBar
        question={make({ decision: "approved", banked: true })}
        displayStatus="terverifikasi"
        jobState="finished"
        onDecide={vi.fn()}
        error={null}
        pending={false}
      />,
    );
    expect(screen.getByText("Tersimpan di Bank Soal")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});
