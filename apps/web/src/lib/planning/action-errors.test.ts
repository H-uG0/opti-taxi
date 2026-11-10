import { describe, expect, it } from "vitest";
import { DATABASE_ERROR, PLAN_CHANGED_ERROR, planningErrorMessage, UNEXPECTED_ERROR } from "./action-errors";

function prismaError(name: string, code?: string): Error {
  const error = new Error("Invalid `prisma.trip.updateMany()` invocation: …") as Error & { code?: string };
  error.name = name;
  if (code) error.code = code;
  return error;
}

describe("planningErrorMessage", () => {
  it("asks to reload when another transaction changed the same rows first", () => {
    expect(planningErrorMessage(prismaError("PrismaClientKnownRequestError", "P2034"))).toBe(PLAN_CHANGED_ERROR);
    expect(planningErrorMessage(prismaError("PrismaClientKnownRequestError", "P2025"))).toBe(PLAN_CHANGED_ERROR);
  });

  it("names a database failure (time-out waiting for the row locks, lost connection) instead of «\u202fconnexion perdue\u202f»", () => {
    expect(planningErrorMessage(prismaError("PrismaClientKnownRequestError", "P2028"))).toBe(DATABASE_ERROR);
    expect(planningErrorMessage(prismaError("PrismaClientInitializationError"))).toBe(DATABASE_ERROR);
    expect(planningErrorMessage(prismaError("PrismaClientUnknownRequestError"))).toBe(DATABASE_ERROR);
  });

  it("falls back to a generic message for anything else, never the raw error", () => {
    expect(planningErrorMessage(new Error("boom"))).toBe(UNEXPECTED_ERROR);
    expect(planningErrorMessage(null)).toBe(UNEXPECTED_ERROR);
    expect(planningErrorMessage("P2034")).toBe(UNEXPECTED_ERROR);
  });
});
