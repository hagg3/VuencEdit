import { describe, it, expect } from "vitest";
import { addBookmark, renameBookmark, deleteBookmark, parseBookmarks, MAX_BOOKMARKS } from "./bookmarks";

describe("bookmarks", () => {
  it("adds with rounded coords and a default name", () => {
    const l = addBookmark([], 10.6, -3.2);
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ name: "Bookmark 1", x: 11, y: -3 });
  });
  it("caps the list", () => {
    let l = [] as ReturnType<typeof addBookmark>;
    for (let i = 0; i < MAX_BOOKMARKS + 5; i++) l = addBookmark(l, i, i);
    expect(l).toHaveLength(MAX_BOOKMARKS);
  });
  it("renames (trimmed, blank ignored) and deletes", () => {
    const l = addBookmark([], 1, 2);
    expect(renameBookmark(l, l[0].id, "  Base ")[0].name).toBe("Base");
    expect(renameBookmark(l, l[0].id, "   ")).toBe(l);
    expect(deleteBookmark(l, l[0].id)).toEqual([]);
  });
  it("tolerates corrupt storage", () => {
    expect(parseBookmarks("nope")).toEqual([]);
    expect(parseBookmarks('{"a":1}')).toEqual([]);
    expect(parseBookmarks('[{"id":"a","name":"n","x":1,"y":2},{"id":3}]')).toHaveLength(1);
    expect(parseBookmarks(null)).toEqual([]);
  });
});
