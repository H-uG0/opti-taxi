import { describe, expect, it } from "vitest";
import { HistoryError } from "./errors";
import { assertDevelopmentDatabase } from "./safety";

const local = "postgresql://optitaxi:secret@localhost:5433/optitaxi?schema=public";

describe("assertDevelopmentDatabase (same rules as the seed)", () => {
  it("accepts a local database and shows the target without credentials", () => {
    const target = assertDevelopmentDatabase({ DATABASE_URL: local });
    expect(target).toBe("optitaxi sur localhost:5433");
    expect(target).not.toContain("secret");
    expect(assertDevelopmentDatabase({ DATABASE_URL: "postgresql://u:p@postgres:5432/db" })).toBe("db sur postgres:5432");
  });

  it("refuses a remote database unless SEED_ALLOW_WIPE=1", () => {
    const remote = { DATABASE_URL: "postgresql://u:p@db.example.com:5432/prod" };
    expect(() => assertDevelopmentDatabase(remote)).toThrow(HistoryError);
    expect(() => assertDevelopmentDatabase(remote)).toThrow(/n'est pas locale/);
    expect(assertDevelopmentDatabase({ ...remote, SEED_ALLOW_WIPE: "1" })).toBe("prod sur db.example.com:5432");
  });

  it("uses the socket host of the query string", () => {
    expect(() => assertDevelopmentDatabase({ DATABASE_URL: "postgresql://u:p@localhost/db?host=db.example.com" })).toThrow(
      /n'est pas locale/,
    );
  });

  it("refuses production, a missing or an invalid URL", () => {
    expect(() => assertDevelopmentDatabase({ NODE_ENV: "production", DATABASE_URL: local })).toThrow(/production/);
    expect(() => assertDevelopmentDatabase({})).toThrow(/n'est pas défini/);
    expect(() => assertDevelopmentDatabase({ DATABASE_URL: "not a url" })).toThrow(/URL valide/);
  });
});
