import { describe, expect, it } from "vitest";
import {
  assertDevelopmentDatabase,
  assertSeedAccountsOnly,
  assertSeedOnlyDatabase,
  FOREIGN_ACCOUNTS_WHERE,
  UnsafeDatabaseError,
} from "./safety";
import { devEmail, SEED_EMAIL_DOMAIN } from "./seed/identity";

const local = "postgresql://optitaxi:secret@localhost:5433/optitaxi?schema=public";
const remote = "postgresql://u:p@db.example.com:5432/prod";

describe("assertDevelopmentDatabase", () => {
  it("accepts a database on this machine and shows the target without credentials", () => {
    const target = assertDevelopmentDatabase("seed", { DATABASE_URL: local });
    expect(target).toBe("optitaxi sur localhost:5433");
    expect(target).not.toContain("secret");
    expect(assertDevelopmentDatabase("history", { DATABASE_URL: "postgresql://u:p@127.0.0.1/db" })).toBe("db sur 127.0.0.1");
    expect(assertDevelopmentDatabase("history", { DATABASE_URL: "postgresql://u:p@[::1]:5433/db" })).toBe("db sur [::1]:5433");
  });

  it("refuses a remote database unless SEED_ALLOW_WIPE=1, naming what the script does", () => {
    expect(() => assertDevelopmentDatabase("seed", { DATABASE_URL: remote })).toThrow(UnsafeDatabaseError);
    expect(() => assertDevelopmentDatabase("seed", { DATABASE_URL: remote })).toThrow(/n'est pas locale.*Le seed efface/);
    expect(() => assertDevelopmentDatabase("history", { DATABASE_URL: remote })).toThrow(/La simulation remplace/);
    expect(() => assertDevelopmentDatabase("reset", { DATABASE_URL: remote })).toThrow(/n'est pas locale.*prisma migrate reset/);
    expect(assertDevelopmentDatabase("seed", { DATABASE_URL: remote, SEED_ALLOW_WIPE: "1" })).toBe("prod sur db.example.com:5432");
    expect(() => assertDevelopmentDatabase("seed", { DATABASE_URL: remote, SEED_ALLOW_WIPE: "true" })).toThrow(/n'est pas locale/);
  });

  it("no longer trusts the docker-compose service name (no script runs inside the compose network)", () => {
    expect(() => assertDevelopmentDatabase("seed", { DATABASE_URL: "postgresql://u:p@postgres:5432/db" })).toThrow(
      /db sur postgres:5432\) n'est pas locale/,
    );
  });

  it("uses the socket host of the query string", () => {
    expect(() => assertDevelopmentDatabase("history", { DATABASE_URL: "postgresql://u:p@localhost/db?host=db.example.com" })).toThrow(
      /n'est pas locale/,
    );
  });

  it("refuses production even with SEED_ALLOW_WIPE=1, and a missing or invalid URL", () => {
    expect(() => assertDevelopmentDatabase("seed", { NODE_ENV: "production", DATABASE_URL: local, SEED_ALLOW_WIPE: "1" })).toThrow(
      /production/,
    );
    expect(() => assertDevelopmentDatabase("history", { NODE_ENV: "production", DATABASE_URL: local })).toThrow(
      /la simulation d'historique ne s'exécute jamais/,
    );
    expect(() => assertDevelopmentDatabase("seed", {})).toThrow(/n'est pas défini/);
    expect(() => assertDevelopmentDatabase("seed", { DATABASE_URL: "not a url" })).toThrow(/URL valide/);
  });
});

describe("seed-only accounts", () => {
  it("matches the seed's accounts by their e-mail domain", () => {
    expect(devEmail("Élodie", "Fabre")).toBe("elodie.fabre@opti-taxi.test");
    expect(devEmail("Élodie", "Fabre").endsWith(SEED_EMAIL_DOMAIN)).toBe(true);
    expect(FOREIGN_ACCOUNTS_WHERE).toEqual({ NOT: { email: { endsWith: "@opti-taxi.test", mode: "insensitive" } } });
  });

  it("refuses a database holding other accounts unless SEED_ALLOW_WIPE=1", () => {
    expect(() => assertSeedAccountsOnly("seed", 0, "optitaxi sur localhost:5433", {})).not.toThrow();
    expect(() => assertSeedAccountsOnly("seed", 1, "optitaxi sur localhost:5433", {})).toThrow(
      /\(optitaxi sur localhost:5433\) contient 1 compte dont l'e-mail ne se termine pas par @opti-taxi\.test/,
    );
    expect(() => assertSeedAccountsOnly("history", 3, "x", {})).toThrow(/3 comptes dont l'e-mail.*La simulation remplace/);
    expect(() => assertSeedAccountsOnly("seed", 3, "x", { SEED_ALLOW_WIPE: "1" })).not.toThrow();
  });

  it("checks the URL before querying, then counts the foreign accounts", async () => {
    const queries: unknown[] = [];
    const count = (result: number) => async (where: unknown) => {
      queries.push(where);
      return result;
    };
    await expect(assertSeedOnlyDatabase("seed", count(0), { DATABASE_URL: local })).resolves.toBe("optitaxi sur localhost:5433");
    expect(queries).toEqual([FOREIGN_ACCOUNTS_WHERE]);

    await expect(assertSeedOnlyDatabase("seed", count(2), { DATABASE_URL: local })).rejects.toThrow(UnsafeDatabaseError);
    await expect(assertSeedOnlyDatabase("seed", count(2), { DATABASE_URL: local, SEED_ALLOW_WIPE: "1" })).resolves.toBe(
      "optitaxi sur localhost:5433",
    );

    queries.length = 0;
    await expect(assertSeedOnlyDatabase("history", count(0), { DATABASE_URL: remote })).rejects.toThrow(/n'est pas locale/);
    expect(queries).toEqual([]);
  });
});
