import { History } from "@/lib/score/history";

interface Doc {
  items: string[];
  title: string;
}

function setup() {
  const doc: Doc = { items: ["a"], title: "One" };
  const history = new History<number>();
  const edit = (label: string, change: () => void, cursor = 0) =>
    history.record(label, () => [doc], change, { before: cursor, after: () => cursor + 1 });
  return { doc, history, edit };
}

describe("History", () => {
  it("undoes and redoes edits in order", () => {
    const { doc, history, edit } = setup();
    edit("Add", () => doc.items.push("b"));
    edit("Rename", () => (doc.title = "Two"));

    expect(history.undoLabel).toBe("Rename");
    expect(history.depth).toBe(2);
    expect(history.undo()?.extra).toEqual({ before: 0, after: 1 });
    expect(doc).toEqual({ items: ["a", "b"], title: "One" });
    history.undo();
    expect(doc).toEqual({ items: ["a"], title: "One" });
    expect(history.canUndo).toBe(false);
    expect(history.undo()).toBeNull();

    expect(history.redoLabel).toBe("Add");
    history.redo();
    history.redo();
    expect(doc).toEqual({ items: ["a", "b"], title: "Two" });
    expect(history.redo()).toBeNull();
  });

  it("forgets undone edits after a new one", () => {
    const { doc, history, edit } = setup();
    edit("Add", () => doc.items.push("b"));
    history.undo();
    edit("Rename", () => (doc.title = "Two"));
    expect(history.canRedo).toBe(false);
  });

  it("rolls back and records nothing when an edit fails", () => {
    const { doc, history, edit } = setup();
    expect(() =>
      edit("Broken", () => {
        doc.items.push("b");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(doc.items).toEqual(["a"]);
    expect(history.canUndo).toBe(false);
  });

  it("clears", () => {
    const { doc, history, edit } = setup();
    edit("Add", () => doc.items.push("b"));
    history.clear();
    expect(history.canUndo || history.canRedo).toBe(false);
  });
});
