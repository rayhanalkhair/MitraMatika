// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { checked, formDataOf, text, texts } from "./form-data";

function formFrom(html: string): HTMLFormElement {
  const form = document.createElement("form");
  form.innerHTML = html;
  return form;
}

describe("form-data readers", () => {
  it("formDataOf/texts/checked read checkbox groups and single checkboxes", () => {
    const form = formFrom(`
      <input name="title" value=" Ulangan 1 " />
      <input type="checkbox" name="studentFields" value="name" checked />
      <input type="checkbox" name="studentFields" value="class" />
      <input type="checkbox" name="studentFields" value="number" checked />
      <input type="checkbox" name="isDefault" checked />
      <input type="checkbox" name="acceptPrivacy" />
      <input type="file" name="logo" />
    `);
    const data = formDataOf(form);

    expect(data).toBeInstanceOf(FormData);
    expect(texts(data, "studentFields")).toEqual(["name", "number"]);
    expect(checked(data, "isDefault")).toBe(true);
    expect(checked(data, "acceptPrivacy")).toBe(false);
    // Raw value: trimming is the schema's job, so the client and the server see the same input.
    expect(text(data, "title")).toBe(" Ulangan 1 ");
  });

  it("reads a missing name as empty and ignores file entries", () => {
    const data = new FormData();
    data.append("logo", new File(["x"], "logo.png"));
    data.append("tags", "a");
    data.append("tags", new File(["y"], "b.png"));

    expect(text(data, "missing")).toBe("");
    expect(text(data, "logo")).toBe("");
    expect(texts(data, "missing")).toEqual([]);
    expect(texts(data, "tags")).toEqual(["a"]);
  });
});
