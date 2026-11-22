// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { renderWithIntl } from "@/test/intl";
import { UnavailableNotice } from "./UnavailableNotice";

afterEach(cleanup);

describe("UnavailableNotice", () => {
  it("is a status for the empty case", () => {
    renderWithIntl(<UnavailableNotice kind="empty" />);
    expect(screen.getByRole("status").textContent).toMatch(/belum tersedia/);
  });

  it("is an alert for a load error and shows no technical detail", () => {
    renderWithIntl(<UnavailableNotice kind="error" />);
    expect(screen.getByRole("alert").textContent).toMatch(/belum dapat dimuat/);
  });
});
