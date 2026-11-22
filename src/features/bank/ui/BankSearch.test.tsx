// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { renderWithIntl } from "@/test/intl";
import { bankQuerySchema } from "../schema/bank-query";
import { BankSearch } from "./BankSearch";

afterEach(cleanup);

describe("BankSearch", () => {
  it("search submits on enter and keeps other filters", () => {
    const query = bankQuerySchema.parse({
      grade: "8",
      status: "terverifikasi",
      sort: "oldest",
      q: "luas",
      page: "4",
    });
    renderWithIntl(<BankSearch query={query} />);
    const form = screen.getByRole<HTMLFormElement>("search");
    expect(form.getAttribute("method")).toBe("get");
    expect(form.getAttribute("action")).toBe("/question-bank");
    // A submit button makes Enter in the field submit the form.
    expect(form.querySelector('button[type="submit"]')).not.toBeNull();
    const field = screen.getByRole<HTMLInputElement>("searchbox", { name: "Cari soal" });
    expect(field.name).toBe("q");
    expect(field.value).toBe("luas");
    const data = new FormData(form);
    expect(data.get("grade")).toBe("8");
    expect(data.get("status")).toBe("terverifikasi");
    expect(data.get("sort")).toBe("oldest");
    // A new search restarts at page 1.
    expect(data.has("page")).toBe(false);
  });
});
