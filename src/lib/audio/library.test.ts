import { filterLibrary, parseTags, tagsOf } from "@/lib/audio/library";
import type { LibraryItem } from "@/lib/tauri";

const item = (over: Partial<LibraryItem>): LibraryItem => ({
  id: "x",
  kind: "cab",
  name: "Cab",
  tags: [],
  file: "",
  sampleRate: 48_000,
  source: "cab.wav",
  builtin: false,
  includesCab: false,
  note: "",
  ...over,
});

const ITEMS = [
  item({
    id: "1",
    name: "5150 capture",
    kind: "amp",
    source: "5150.nam",
    tags: ["Metal", "djent"],
  }),
  item({ id: "2", name: "Greenback 4×12", source: "gb.wav", tags: ["rock"] }),
  item({ id: "3", name: "V30 close mic", source: "v30-sm57.wav", tags: ["metal"] }),
  item({ id: "4", name: "Plain cab" }),
];

describe("the library's tags and filter", () => {
  it("lists every tag once, whatever its case, in order", () => {
    expect(tagsOf(ITEMS)).toEqual(["djent", "Metal", "rock"]);
    expect(tagsOf([])).toEqual([]);
  });

  it("filters by tag, ignoring case", () => {
    expect(filterLibrary(ITEMS, { search: "", tag: "metal" }).map((i) => i.id)).toEqual(["1", "3"]);
    expect(filterLibrary(ITEMS, { search: "", tag: "nope" })).toEqual([]);
  });

  it("searches names, tags and file names, every word having to match", () => {
    const ids = (search: string) => filterLibrary(ITEMS, { search, tag: null }).map((i) => i.id);
    expect(ids("")).toEqual(["1", "2", "3", "4"]);
    expect(ids("green")).toEqual(["2"]);
    expect(ids("sm57")).toEqual(["3"]);
    expect(ids("DJENT")).toEqual(["1"]);
    expect(ids("metal v30")).toEqual(["3"]);
    expect(ids("metal rock")).toEqual([]);
  });

  it("combines the search and the tag", () => {
    expect(filterLibrary(ITEMS, { search: "v30", tag: "metal" }).map((i) => i.id)).toEqual(["3"]);
    expect(filterLibrary(ITEMS, { search: "green", tag: "metal" })).toEqual([]);
  });

  it("parses typed tags", () => {
    expect(parseTags(" a ,, b,a ")).toEqual(["a", "b"]);
  });
});
