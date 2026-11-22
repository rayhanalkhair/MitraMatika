// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { renderWithIntl } from "@/test/intl";
import { useContext, useState } from "react";
import userEvent from "@testing-library/user-event";
import type { GenerationFormState } from "@/features/generation/schema/form-state";
import type { GenerationMaterial } from "@/features/generation/service/material-selection";

const actionMock = vi.hoisted(() => ({
  fn: vi.fn<
    (previous: GenerationFormState, data: FormData) => Promise<GenerationFormState>
  >(() => Promise.resolve({})),
}));
vi.mock("@/features/generation/actions/create-request", () => ({
  createGenerationRequestAction: actionMock.fn,
}));

const routerMock = vi.hoisted(() => ({
  replaced: false,
  replace: vi.fn<(href: string) => void>(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: (href: string) => {
      routerMock.replaced = true;
      routerMock.replace(href);
    },
  }),
}));

import { TopicPicker } from "@/features/curriculum/ui/TopicPicker";
import { GenerationForm } from "./GenerationForm";
import { GradeSelector } from "@/features/curriculum/ui/GradeSelector";
import { TopicErrorContext } from "./topic-error-context";

beforeEach(() => {
  actionMock.fn.mockClear();
  routerMock.replaced = false;
});
afterEach(cleanup);

describe("GenerationForm", () => {
  it("renders its children, the quantity and difficulty groups and the submit button", () => {
    renderWithIntl(
      <GenerationForm selectedTopic={null}>
        <div data-testid="picker">picker</div>
      </GenerationForm>,
    );
    expect(screen.getByTestId("picker")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Jumlah soal" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Tingkat kesulitan" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Buat soal" })).toBeTruthy();
  });

  it("defaults to 5 questions and sedang", () => {
    renderWithIntl(<GenerationForm selectedTopic="spldv">{null}</GenerationForm>);
    expect(screen.getByRole<HTMLInputElement>("radio", { name: "5" }).checked).toBe(true);
    expect(screen.getByRole<HTMLInputElement>("radio", { name: "Sedang" }).checked).toBe(
      true,
    );
  });

  it("offers quantities 1 to 5 and the three difficulties", () => {
    renderWithIntl(<GenerationForm selectedTopic="spldv">{null}</GenerationForm>);
    for (const n of ["1", "2", "3", "4", "5"]) {
      expect(screen.getByRole("radio", { name: n })).toBeTruthy();
    }
    for (const label of ["Mudah", "Sedang", "Sulit"]) {
      expect(screen.getByRole("radio", { name: label })).toBeTruthy();
    }
  });

  it("posts the chosen quantity, difficulty and the fixed grade", async () => {
    renderWithIntl(<GenerationForm selectedTopic="spldv">{null}</GenerationForm>);
    await userEvent.click(screen.getByRole("radio", { name: "3" }));
    await userEvent.click(screen.getByRole("radio", { name: "Sulit" }));
    await userEvent.click(screen.getByRole("button", { name: "Buat soal" }));
    const data = actionMock.fn.mock.calls[0][1];
    expect(data.get("count")).toBe("3");
    expect(data.get("difficulty")).toBe("sulit");
    expect(data.get("grade")).toBe("8");
  });

  it("posts the way back to an assessment only when it is given", async () => {
    const back = "/assessment-builder/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const { unmount } = renderWithIntl(
      <GenerationForm selectedTopic="spldv" returnTo={back}>
        {null}
      </GenerationForm>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Buat soal" }));
    expect(actionMock.fn.mock.calls[0][1].get("returnTo")).toBe(back);
    unmount();
    renderWithIntl(<GenerationForm selectedTopic="spldv">{null}</GenerationForm>);
    await userEvent.click(screen.getByRole("button", { name: "Buat soal" }));
    expect(actionMock.fn.mock.calls[1][1].has("returnTo")).toBe(false);
  });

  it("shows the topic error as an alert", async () => {
    actionMock.fn.mockResolvedValueOnce({
      fieldErrors: { topic: "topik" },
    });
    renderWithIntl(<GenerationForm selectedTopic="spldv">{null}</GenerationForm>);
    await userEvent.click(screen.getByRole("button", { name: "Buat soal" }));
    const error = await screen.findByText("Pilih satu topik terlebih dahulu.");
    expect(error.getAttribute("role")).toBe("alert");
  });

  it("adds the source step when the page offers materials, and shows its error", async () => {
    actionMock.fn.mockResolvedValueOnce({
      fieldErrors: { material: "pagesUnavailable" },
    });
    renderWithIntl(
      <GenerationForm
        selectedTopic="spldv"
        materials={[{ id: "m1", title: "Buku SPLDV", pageCount: 3, sections: [] }]}
      >
        {null}
      </GenerationForm>,
    );
    expect(screen.getByRole("heading", { name: "Sumber soal" })).toBeTruthy();
    // The topic is now step 3.
    const topicStep = screen
      .getByRole("heading", { name: "Pilih topik" })
      .closest("section");
    expect(topicStep?.querySelector("[data-step]")?.textContent).toBe("3");
    await userEvent.click(screen.getByRole("button", { name: "Buat soal" }));
    const error = await screen.findByText(/Ada halaman yang tidak ada/);
    expect(error.getAttribute("role")).toBe("alert");
    expect(actionMock.fn.mock.calls[0][1].get("source")).toBe("topic");
  });

  it("has no source step without materials", () => {
    renderWithIntl(<GenerationForm selectedTopic="spldv">{null}</GenerationForm>);
    expect(screen.queryByRole("heading", { name: "Sumber soal" })).toBeNull();
  });

  it("offers the topic error id to its children so the list can reference it", async () => {
    function Probe() {
      const id = useContext(TopicErrorContext);
      return <div data-testid="probe">{id ?? "none"}</div>;
    }
    actionMock.fn.mockResolvedValueOnce({
      fieldErrors: { topic: "topik" },
    });
    renderWithIntl(
      <GenerationForm selectedTopic="spldv">
        <Probe />
      </GenerationForm>,
    );
    expect(screen.getByTestId("probe").textContent).toBe("none");
    await userEvent.click(screen.getByRole("button", { name: "Buat soal" }));
    const error = await screen.findByText("Pilih satu topik terlebih dahulu.");
    expect(screen.getByTestId("probe").textContent).toBe(error.id);
  });

  it("keeps the chosen quantity and difficulty after the action returns errors", async () => {
    actionMock.fn.mockResolvedValueOnce({
      fieldErrors: { topic: "topik" },
    });
    renderWithIntl(<GenerationForm selectedTopic="spldv">{null}</GenerationForm>);
    await userEvent.click(screen.getByRole("radio", { name: "3" }));
    await userEvent.click(screen.getByRole("radio", { name: "Sulit" }));
    await userEvent.click(screen.getByRole("button", { name: "Buat soal" }));
    await screen.findByText("Pilih satu topik terlebih dahulu.");
    expect(screen.getByRole<HTMLInputElement>("radio", { name: "3" }).checked).toBe(true);
    expect(screen.getByRole<HTMLInputElement>("radio", { name: "Sulit" }).checked).toBe(
      true,
    );
  });

  it("disables the button and shows the progress label while the action is pending", async () => {
    let resolve: (state: GenerationFormState) => void = () => undefined;
    actionMock.fn.mockImplementationOnce(
      () => new Promise<GenerationFormState>((r) => (resolve = r)),
    );
    renderWithIntl(<GenerationForm selectedTopic="spldv">{null}</GenerationForm>);
    await userEvent.click(screen.getByRole("button", { name: "Buat soal" }));
    const pending = await screen.findByRole<HTMLButtonElement>("button", {
      name: "Membuat…",
    });
    expect(pending.disabled).toBe(true);
    expect(pending.getAttribute("aria-busy")).toBe("true");
    expect(pending.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    await act(() => {
      resolve({});
      return Promise.resolve();
    });
    expect(
      (await screen.findByRole<HTMLButtonElement>("button", { name: "Buat soal" }))
        .disabled,
    ).toBe(false);
  });

  it("ties a server error on the count to the group and focuses its checked radio", async () => {
    actionMock.fn.mockResolvedValueOnce({ fieldErrors: { count: "jumlah" } });
    renderWithIntl(<GenerationForm selectedTopic="spldv">{null}</GenerationForm>);
    await userEvent.click(screen.getByRole("button", { name: "Buat soal" }));
    const error = await screen.findByText("Pilih jumlah soal 1 sampai 5.");
    const group = screen.getByRole("group", { name: "Jumlah soal" });
    expect(group.getAttribute("aria-describedby")).toBe(error.id);
    expect(group.getAttribute("data-invalid")).toBe("true");
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole("radio", { name: "5" }));
    });
  });

  it("shows the generic error", async () => {
    actionMock.fn.mockResolvedValueOnce({ error: "generic" });
    renderWithIntl(<GenerationForm selectedTopic="spldv">{null}</GenerationForm>);
    await userEvent.click(screen.getByRole("button", { name: "Buat soal" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Terjadi kesalahan");
  });

  it("links to the active request when one exists", async () => {
    actionMock.fn.mockResolvedValueOnce({
      activeRequestId: "55555555-5555-4555-8555-555555555555",
    });
    renderWithIntl(<GenerationForm selectedTopic="spldv">{null}</GenerationForm>);
    await userEvent.click(screen.getByRole("button", { name: "Buat soal" }));
    const link = await screen.findByRole<HTMLAnchorElement>("link", {
      name: "Buka permintaan itu",
    });
    expect(link.getAttribute("href")).toBe(
      "/generate/55555555-5555-4555-8555-555555555555",
    );
  });

  it("shows the daily limit with the remaining count and the reset time in the viewer's zone", async () => {
    actionMock.fn.mockResolvedValueOnce({
      dailyLimit: {
        limit: 30,
        used: 25,
        remaining: 5,
        resetsAt: "2026-11-10T17:00:00.000Z",
      },
    });
    renderWithIntl(<GenerationForm selectedTopic="spldv">{null}</GenerationForm>);
    await userEvent.click(screen.getByRole("button", { name: "Buat soal" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("25 dari 30");
    expect(alert.textContent).toContain("Sisa 5 soal");
    // 17:00 UTC is 00:00 on 11 Nov in Asia/Jakarta (the test provider's zone).
    expect(alert.textContent).toContain("11 November");
    expect(alert.textContent).toContain("00.00");
  });

  it("renders numbered sections for grade, topic, count and difficulty", () => {
    renderWithIntl(
      <GenerationForm selectedTopic="spldv" gradeSlot={<GradeSelector />}>
        <input type="hidden" name="topic" value="" />
      </GenerationForm>,
    );
    const sections = screen.getAllByRole("region");
    expect(
      sections.map((s) => within(s).getByRole("heading", { level: 2 }).textContent),
    ).toEqual(["Pilih kelas", "Pilih topik", "Jumlah soal", "Tingkat kesulitan"]);
    expect(sections.map((s) => s.querySelector("[data-step]")?.textContent)).toEqual([
      "1",
      "2",
      "3",
      "4",
    ]);
  });

  it("marks the selected count and difficulty with a visible selected style", () => {
    renderWithIntl(<GenerationForm selectedTopic="spldv">{null}</GenerationForm>);
    for (const name of ["5", "Sedang"]) {
      const radio = screen.getByRole<HTMLInputElement>("radio", { name });
      expect(radio.checked).toBe(true);
      const label = document.querySelector(`label[for="${radio.id}"]`)!;
      expect(label.className).toContain("peer-checked:bg-primary");
      expect(label.className).toContain("min-h-13");
    }
  });

  it("has a single primary submit button", () => {
    renderWithIntl(<GenerationForm selectedTopic="spldv">{null}</GenerationForm>);
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0].getAttribute("type")).toBe("submit");
    expect(buttons[0].className).toContain("bg-primary");
  });

  it("keeps the posted field names grade, topic, count and difficulty", async () => {
    renderWithIntl(
      <GenerationForm selectedTopic="spldv" gradeSlot={<GradeSelector />}>
        <input type="hidden" name="topic" value="spldv" />
      </GenerationForm>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Buat soal" }));
    const data = actionMock.fn.mock.calls[0][1];
    // The pickers' own choice radios may post too; the action reads only these four names.
    for (const name of ["grade", "topic", "count", "difficulty"]) {
      expect(data.has(name), name).toBe(true);
    }
    expect(data.getAll("grade")).toEqual(["8"]);
  });
});

describe("GenerationForm with the real topic picker", () => {
  const BACK =
    "/assessment-builder/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa?since=2026-11-19T10%3A00%3A00.000Z";
  const MATERIAL = "55555555-5555-4555-8555-555555555555";
  const SECTION = "66666666-6666-4666-8666-666666666666";
  const MATERIALS: GenerationMaterial[] = [
    {
      id: MATERIAL,
      title: "Buku SPLDV",
      pageCount: 12,
      sections: [{ id: SECTION, title: "Bab 1 Persamaan", pageStart: 1, pageEnd: 5 }],
    },
  ];
  const version = {
    id: "v",
    code: "c",
    title: "Kurikulum Merdeka",
    sourceTitle: "S",
    sourceUrl: "https://example.test",
    decreeRef: null,
    publishedOn: "2025-07-16",
    retrievedOn: "2026-09-23",
  };
  const topics = [
    {
      id: "spldv",
      stableKey: "spldv",
      grade: 8 as const,
      title: "SPLDV",
      scopeNotes: "Catatan",
      sortOrder: 1,
      sourceRef: "ref",
      element: { code: "aljabar", name: "Aljabar" },
      objectives: [],
    },
  ];

  // The page re-renders from the URL after the picker's router.replace: the new URL has no returnTo.
  function Page({
    returnTo = BACK,
    materials,
  }: {
    returnTo?: string;
    materials?: GenerationMaterial[];
  }) {
    const [params, setParams] = useState<{ returnTo?: string; topic: string | null }>({
      returnTo,
      topic: null,
    });
    routerMock.replace.mockImplementation((href: string) => {
      const url = new URL(href, "http://x");
      setParams({
        returnTo: url.searchParams.get("returnTo") ?? undefined,
        topic: url.searchParams.get("topic"),
      });
    });
    return (
      <GenerationForm
        selectedTopic={params.topic}
        returnTo={params.returnTo}
        materials={materials}
      >
        <TopicPicker topics={topics} version={version} selectedKey={params.topic} />
      </GenerationForm>
    );
  }

  const submit = () => userEvent.click(screen.getByRole("button", { name: "Buat soal" }));
  const chooseTopic = () => userEvent.click(screen.getByRole("radio", { name: /SPLDV/ }));
  const pickMaterial = async () => {
    await userEvent.click(screen.getByRole("radio", { name: "Dari materi" }));
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Materi" }),
      MATERIAL,
    );
  };

  it("still posts returnTo after choosing a topic rewrote the URL", async () => {
    renderWithIntl(<Page />);
    await chooseTopic();
    expect(routerMock.replaced).toBe(true);
    await submit();
    const data = actionMock.fn.mock.calls[0][1];
    expect(data.get("topic")).toBe("spldv");
    expect(data.get("returnTo")).toBe(BACK);
  });

  it("keeps returnTo and the material choice when the topic URL changes after them", async () => {
    renderWithIntl(<Page materials={MATERIALS} />);
    await pickMaterial();
    await userEvent.click(screen.getByRole("radio", { name: "Halaman" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Halaman" }), "2-3");
    await chooseTopic();
    expect(routerMock.replaced).toBe(true);
    await submit();
    expect(actionMock.fn).toHaveBeenCalledTimes(1);
    const data = actionMock.fn.mock.calls[0][1];
    expect(data.get("returnTo")).toBe(BACK);
    expect(data.get("source")).toBe("material");
    expect(data.get("materialId")).toBe(MATERIAL);
    expect(data.get("materialScope")).toBe("pages");
    expect(data.get("pages")).toBe("2-3");
  });

  it("checks the topic in the browser: the error shows, the action is not called, focus moves to the list", async () => {
    renderWithIntl(<Page />);
    await submit();
    const error = await screen.findByText("Pilih satu topik terlebih dahulu.");
    expect(error.getAttribute("role")).toBe("alert");
    expect(actionMock.fn).not.toHaveBeenCalled();
    const list = screen.getByRole("group", { name: "Pilih topik" });
    expect(list.getAttribute("aria-describedby")).toBe(error.id);
    const radio = screen.getByRole("radio", { name: /SPLDV/ });
    expect(list.getAttribute("data-invalid")).toBe("true");
    expect(document.activeElement).toBe(radio);
  });

  it("choosing a topic in the picker clears the topic error after a failed submit", async () => {
    renderWithIntl(<Page />);
    await submit();
    await screen.findByText("Pilih satu topik terlebih dahulu.");
    await chooseTopic();
    await waitFor(() => {
      expect(screen.queryByText("Pilih satu topik terlebih dahulu.")).toBeNull();
    });
    expect(
      screen.getByRole("group", { name: "Pilih topik" }).hasAttribute("aria-describedby"),
    ).toBe(false);
    await submit();
    expect(actionMock.fn).toHaveBeenCalledTimes(1);
  });

  it("starts from the topic in the URL", async () => {
    renderWithIntl(
      <GenerationForm selectedTopic="spldv">
        <TopicPicker topics={topics} version={version} selectedKey="spldv" />
      </GenerationForm>,
    );
    await submit();
    expect(actionMock.fn).toHaveBeenCalledTimes(1);
    expect(actionMock.fn.mock.calls[0][1].get("topic")).toBe("spldv");
  });

  it("count and difficulty default to 5 and sedang and are posted", async () => {
    renderWithIntl(<Page />);
    await chooseTopic();
    await submit();
    const data = actionMock.fn.mock.calls[0][1];
    expect(data.get("count")).toBe("5");
    expect(data.get("difficulty")).toBe("sedang");
    expect(data.get("source")).toBeNull();
  });

  it("checks the material fields only when the source is a material", async () => {
    renderWithIntl(<Page materials={MATERIALS} />);
    await chooseTopic();
    await userEvent.click(screen.getByRole("radio", { name: "Dari materi" }));
    await submit();
    const error = await screen.findByText("Pilih materi terlebih dahulu.");
    expect(error.id).toBe("error-material");
    expect(actionMock.fn).not.toHaveBeenCalled();
    const select = screen.getByRole("combobox", { name: "Materi" });
    expect(select.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(select);

    // Back to the topic: the hidden branch's error goes and no longer blocks the submit.
    await userEvent.click(screen.getByRole("radio", { name: "Topik kurikulum" }));
    await waitFor(() => {
      expect(screen.queryByText("Pilih materi terlebih dahulu.")).toBeNull();
    });
    await submit();
    expect(actionMock.fn).toHaveBeenCalledTimes(1);
    expect(actionMock.fn.mock.calls[0][1].get("source")).toBe("topic");
  });

  it("re-checks the chosen chapters and the page list as the teacher fixes them", async () => {
    renderWithIntl(<Page materials={MATERIALS} />);
    await chooseTopic();
    await pickMaterial();
    await userEvent.click(screen.getByRole("radio", { name: "Bab" }));
    await submit();
    await screen.findByText("Pilih minimal satu bab.");
    // A single chapter is still a list of chapters.
    await userEvent.click(screen.getByRole("checkbox", { name: /Bab 1 Persamaan/ }));
    await waitFor(() => {
      expect(screen.queryByText("Pilih minimal satu bab.")).toBeNull();
    });

    await userEvent.click(screen.getByRole("radio", { name: "Halaman" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Halaman" }), "3-1");
    await submit();
    await screen.findByText(/Tulis halaman seperti 1-3, 5/);
    await userEvent.clear(screen.getByRole("textbox", { name: "Halaman" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Halaman" }), "1-3");
    await waitFor(() => {
      expect(screen.queryByText(/Tulis halaman seperti 1-3, 5/)).toBeNull();
    });
    await submit();
    expect(actionMock.fn).toHaveBeenCalledTimes(1);
    expect(actionMock.fn.mock.calls[0][1].get("pages")).toBe("1-3");
  });

  it("drops the chapters of another material when the material changes", async () => {
    const OTHER = "77777777-7777-4777-8777-777777777777";
    renderWithIntl(
      <Page
        materials={[
          ...MATERIALS,
          {
            id: OTHER,
            title: "Lembar kerja",
            pageCount: 3,
            sections: [
              {
                id: "88888888-8888-4888-8888-888888888888",
                title: "Bab A",
                pageStart: 1,
                pageEnd: 3,
              },
            ],
          },
        ]}
      />,
    );
    await chooseTopic();
    await pickMaterial();
    await userEvent.click(screen.getByRole("radio", { name: "Bab" }));
    await userEvent.click(screen.getByRole("checkbox", { name: /Bab 1 Persamaan/ }));
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Materi" }),
      OTHER,
    );
    await submit();
    expect(await screen.findByText("Pilih minimal satu bab.")).toBeTruthy();
    expect(actionMock.fn).not.toHaveBeenCalled();
  });

  it("shows the server's material refusal, focuses the material and clears it on a fix", async () => {
    actionMock.fn.mockResolvedValueOnce({
      fieldErrors: { material: "pagesUnavailable" },
    });
    renderWithIntl(<Page materials={MATERIALS} />);
    await chooseTopic();
    await pickMaterial();
    await userEvent.click(screen.getByRole("radio", { name: "Halaman" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Halaman" }), "11-12");
    await submit();
    await screen.findByText(/Ada halaman yang tidak ada/);
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole("combobox", { name: "Materi" }),
      );
    });
    // Every typed value stays.
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Halaman" }).value).toBe(
      "11-12",
    );
    await userEvent.type(screen.getByRole("textbox", { name: "Halaman" }), "{Backspace}");
    await waitFor(() => {
      expect(screen.queryByText(/Ada halaman yang tidak ada/)).toBeNull();
    });
  });

  it("has no axe violations after a failed submit (colour contrast excluded)", async () => {
    const { container } = renderWithIntl(<Page materials={MATERIALS} />);
    await userEvent.click(screen.getByRole("radio", { name: "Dari materi" }));
    await submit();
    await screen.findByText("Pilih materi terlebih dahulu.");
    const results = await axe.run(container, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});
