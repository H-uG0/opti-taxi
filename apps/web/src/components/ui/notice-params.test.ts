import { describe, expect, it } from "vitest";
import { withoutNoticeParams } from "./notice-params";

describe("withoutNoticeParams", () => {
  it("drops « cree » and « enregistre », keeps the other notices", () => {
    expect(withoutNoticeParams("?enregistre=1")).toBe("");
    expect(withoutNoticeParams("?cree=1")).toBe("");
    expect(withoutNoticeParams("?enregistre=1&sync=a.b")).toBe("?sync=a.b");
  });

  it("leaves an address without them alone", () => {
    expect(withoutNoticeParams("")).toBeNull();
    expect(withoutNoticeParams("?sync=a.b")).toBeNull();
  });
});
