import { describe, expect, it, vi } from "vitest";
import { logError, redactConsoleArgs, safeErrorFields } from "./log";

class PrismaClientValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrismaClientValidationError";
  }
}

class PrismaClientKnownRequestError extends Error {
  code = "P2002";
  meta = { target: ["registration"], modelName: "Vehicle" };
  constructor(message: string) {
    super(message);
    this.name = "PrismaClientKnownRequestError";
  }
}

const invocation = 'Invalid `prisma.trip.create()` invocation:\n{ data: { pickupAddress: "12 rue du Patient Fictif" } }';
const FRAMES = /^(\s+at .+\n?)+$/;

describe("safeErrorFields", () => {
  it("drops the message of a Prisma error, which prints the query arguments, and keeps the frames", () => {
    const fields = safeErrorFields(new PrismaClientValidationError(invocation));
    expect(Object.keys(fields).sort()).toEqual(["name", "stack"]);
    expect(fields.name).toBe("PrismaClientValidationError");
    expect(fields.stack).toMatch(FRAMES);
    expect(JSON.stringify(fields)).not.toContain("Patient Fictif");
  });

  it("keeps the code, target and model of a known request error", () => {
    expect(safeErrorFields(new PrismaClientKnownRequestError(invocation))).toEqual({
      name: "PrismaClientKnownRequestError",
      code: "P2002",
      target: ["registration"],
      model: "Vehicle",
      stack: expect.stringMatching(FRAMES),
    });
  });

  it("keeps the message and the frames of other errors, never a multi-line message in the stack", () => {
    const fields = safeErrorFields(new Error("fetch failed\n12 rue du Patient Fictif", { cause: new PrismaClientValidationError(invocation) }));
    expect(fields.name).toBe("Error");
    expect(fields.message).toBe("fetch failed\n12 rue du Patient Fictif");
    expect(fields.stack).toMatch(FRAMES);
    expect(String(fields.stack)).not.toContain("Patient Fictif");
    expect(fields.cause).toMatchObject({ name: "PrismaClientValidationError" });
    expect(JSON.stringify(fields.cause)).not.toContain("Patient Fictif");
  });

  it("logs only the type of a non-error value", () => {
    expect(safeErrorFields("12 rue du Patient Fictif")).toEqual({ error: "string" });
  });
});

describe("redactConsoleArgs", () => {
  it("replaces a Prisma error with its safe fields and keeps the Next.js digest", () => {
    const error = Object.assign(new PrismaClientValidationError(invocation), { digest: "4242" });
    const [text, redacted] = redactConsoleArgs(["Error in page", error]);
    expect(text).toBe("Error in page");
    expect(redacted).toEqual({ name: "PrismaClientValidationError", stack: expect.stringMatching(FRAMES), digest: "4242" });
    expect(JSON.stringify(redacted)).not.toContain("Patient Fictif");
  });

  it("redacts an error caused by a Prisma error", () => {
    const wrapped = new Error(invocation, { cause: new PrismaClientKnownRequestError(invocation) });
    const [redacted] = redactConsoleArgs([wrapped]);
    expect(redacted).toMatchObject({ name: "PrismaClientKnownRequestError", code: "P2002", target: ["registration"], model: "Vehicle" });
    expect(JSON.stringify(redacted)).not.toContain("Patient Fictif");
  });

  it("passes other errors and values through unchanged", () => {
    const plain = new Error("fetch failed");
    const args = ["text", 3, plain, { a: 1 }];
    const out = redactConsoleArgs(args);
    expect(out).toEqual(args);
    expect(out[2]).toBe(plain);
  });
});

describe("logError", () => {
  it("writes the context, the ids and the safe fields", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logError("createTrip failed", new PrismaClientValidationError(invocation), { patientId: "p1" });
    expect(spy).toHaveBeenCalledWith(
      "createTrip failed",
      expect.objectContaining({ patientId: "p1", name: "PrismaClientValidationError" }),
    );
    expect(JSON.stringify(spy.mock.calls)).not.toContain("Patient Fictif");
    spy.mockRestore();
  });
});
