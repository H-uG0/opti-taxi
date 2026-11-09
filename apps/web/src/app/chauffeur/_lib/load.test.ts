import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadDriverRoutes } from "./load";

// The roadmap query against a fake Prisma client: what is read for the crew, not the database.
const fake = vi.hoisted(() => ({ route: { findMany: vi.fn() } }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ requireDriverAccount: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: fake }));

type Select = Record<string, unknown>;

/** The `select` of the nested relation at `path` in the route query. */
function selectAt(path: string[]): Select {
  const query = fake.route.findMany.mock.calls[0]?.[0] as { select: Select };
  return path.reduce<Select>((select, key) => (select[key] as { select: Select }).select, query.select);
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.route.findMany.mockResolvedValue([]);
});

describe("loadDriverRoutes", () => {
  it("reads the facility's and the depot's instructions, and the payer, for the crew", async () => {
    await loadDriverRoutes("drv_1", "2026-11-10", "2026-11-09");

    expect(selectAt(["stops", "trip", "facility"])).toEqual({ name: true, phone: true, notes: true });
    expect(selectAt(["vehicle", "depot"])).toMatchObject({ name: true, address: true, notes: true });
    expect(selectAt(["stops", "trip"])).toMatchObject({ payer: true, notes: true });
    // Home access notes come with the patient; nothing else of the patient's record.
    expect(selectAt(["stops", "trip", "patient"])).toEqual({
      firstName: true,
      lastName: true,
      phone: true,
      mobility: true,
      accessNotes: true,
    });
  });

  it("reads nothing outside today and tomorrow", async () => {
    expect(await loadDriverRoutes("drv_1", "2026-11-12", "2026-11-09")).toEqual([]);
    expect(fake.route.findMany).not.toHaveBeenCalled();
  });
});
