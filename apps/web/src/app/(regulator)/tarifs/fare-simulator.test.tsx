// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_FARE_RULES, fareEuros, sameRide, type FareRules } from "@/lib/domain/fare";
import { toFareGrid } from "@/lib/domain/tariffs";
import { formatEuros } from "@/lib/labels";
import { tariffRow } from "@/test/tariff-fixtures";
import { FareSimulator, type SimulatorGrid } from "./fare-simulator";

afterEach(cleanup);

const taxi: SimulatorGrid = {
  ...toFareGrid(tariffRow({ nightRate: 0.5, emptyLegRateShort: 0.5, emptyLegRateLong: 0.25 })),
  id: "taxi",
  name: "Taxi 13",
};

function aloneAtNight(rules: FareRules): string {
  const ride = { ...sameRide(25, 1, 1290, 50), emptyLeg: true };
  const flags = { bigCity: false, agglomeration: false, hospitalLinked: true, wheelchair: false, tollAmount: 0 };
  // As the page reads it: the testing library collapses the non-breaking spaces of the amount.
  const amount = fareEuros(taxi, flags, { tpmrEquipped: false }, ride, rules, { date: "2026-11-10", holidays: new Set() });
  return formatEuros(amount).replace(/\s+/g, " ");
}

function showAloneAtNight(rules: FareRules, emptyLegCounted = true): void {
  render(<FareSimulator grids={[taxi]} defaultGridId="taxi" rules={rules} emptyLegCounted={emptyLegCounted} />);
  fireEvent.change(screen.getByLabelText("Moment"), { target: { value: "night" } });
}

describe("FareSimulator", () => {
  it("prices the empty leg with the company's reading of the surcharge order", () => {
    const additive: FareRules = { ...DEFAULT_FARE_RULES, emptyLegOrder: "ADDITIVE" };
    expect(aloneAtNight(additive)).not.toBe(aloneAtNight(DEFAULT_FARE_RULES));

    showAloneAtNight(additive);
    fireEvent.click(screen.getByLabelText("Dialyse, chimiothérapie ou radiothérapie avec retour à vide (patient seul)"));
    expect(screen.getAllByText(aloneAtNight(additive)).length).toBeGreaterThan(0);
    cleanup();

    showAloneAtNight(DEFAULT_FARE_RULES);
    fireEvent.click(screen.getByLabelText("Dialyse, chimiothérapie ou radiothérapie avec retour à vide (patient seul)"));
    expect(screen.getAllByText(aloneAtNight(DEFAULT_FARE_RULES)).length).toBeGreaterThan(0);
  });

  it("offers no empty leg when the company does not count it", () => {
    showAloneAtNight(DEFAULT_FARE_RULES, false);
    expect(screen.queryByLabelText(/retour à vide/)).toBeNull();
  });
});
