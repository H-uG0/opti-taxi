import { describe, expect, it } from "vitest";
import { violationCodeSchema } from "@/lib/optimizer/contract";
import { VIOLATION_LABELS } from "./labels";

describe("VIOLATION_LABELS", () => {
  it("names every violation code of the contract in French", () => {
    for (const code of violationCodeSchema.options) expect([code, VIOLATION_LABELS[code]]).toEqual([code, expect.any(String)]);
  });
});
