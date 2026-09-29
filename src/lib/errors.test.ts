import { errorText } from "@/lib/errors";

describe("errorText", () => {
  it.each([
    [new Error("boom"), "boom"],
    [{ kind: "io", message: "Disk full" }, "Disk full"],
    ["plain text", "plain text"],
    [42, "42"],
    [null, "null"],
    [{ message: 5 }, "[object Object]"],
  ])("%o → %s", (error, text) => {
    expect(errorText(error)).toBe(text);
  });
});
