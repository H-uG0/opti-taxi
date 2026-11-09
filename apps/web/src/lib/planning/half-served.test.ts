import { describe, expect, it } from "vitest";
import { halfServedPairs, type PairableTrip } from "./half-served";

function leg(id: string, patientId: string, direction: PairableTrip["direction"], vehicleId: string | null, minute: number): PairableTrip {
  return {
    id,
    patientId,
    direction,
    facilityId: "fac",
    appointmentMinute: direction === "OUTBOUND" ? minute : null,
    readyMinute: direction === "RETURN" ? minute : null,
    vehicleId,
  };
}

describe("half-served outbound/return pairs", () => {
  it("finds the return left without a vehicle after a served outbound, and the reverse", () => {
    const result = halfServedPairs([
      leg("a_out", "a", "OUTBOUND", "taxi1", 480),
      leg("a_ret", "a", "RETURN", null, 720),
      leg("b_out", "b", "OUTBOUND", null, 480),
      leg("b_ret", "b", "RETURN", "taxi2", 720),
      leg("c_out", "c", "OUTBOUND", null, 480),
      leg("c_ret", "c", "RETURN", null, 720),
      leg("d_out", "d", "OUTBOUND", "taxi1", 600),
      leg("d_ret", "d", "RETURN", "taxi3", 780),
    ]);
    expect([...result.entries()]).toEqual([
      ["a_ret", { tripId: "a_out", vehicleId: "taxi1" }],
      ["b_out", { tripId: "b_ret", vehicleId: "taxi2" }],
    ]);
  });

  it("pairs like the optimizer: a return goes with the latest outbound before its end of session", () => {
    const result = halfServedPairs([
      leg("morning_out", "a", "OUTBOUND", "taxi1", 480),
      leg("morning_ret", "a", "RETURN", "taxi1", 600),
      leg("afternoon_out", "a", "OUTBOUND", "taxi1", 840),
      leg("afternoon_ret", "a", "RETURN", null, 960),
      leg("lone_ret", "z", "RETURN", null, 700),
    ]);
    expect([...result.keys()]).toEqual(["afternoon_ret"]);
  });
});
