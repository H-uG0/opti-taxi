import { describe, expect, it } from "vitest";
import { isValidPoint, navigationLinks, regulatorContact, telHref } from "./links";

describe("navigationLinks", () => {
  it("builds Google Maps, Waze and geo: links to the coordinates", () => {
    expect(navigationLinks({ lat: 43.2965, lng: 5.3698 })).toEqual({
      googleMaps: "https://www.google.com/maps/dir/?api=1&destination=43.2965,5.3698&travelmode=driving",
      waze: "https://waze.com/ul?ll=43.2965,5.3698&navigate=yes",
      geo: "geo:43.2965,5.3698?q=43.2965,5.3698",
    });
  });

  it("rounds to 6 decimals without exponent notation", () => {
    const links = navigationLinks({ lat: 44.559638123456789, lng: 0.0000001 });
    expect(links?.waze).toBe("https://waze.com/ul?ll=44.559638,0&navigate=yes");
    expect(navigationLinks({ lat: 45, lng: -0.5 })?.geo).toBe("geo:45,-0.5?q=45,-0.5");
  });

  it("refuses unusable coordinates", () => {
    expect(navigationLinks({ lat: Number.NaN, lng: 5 })).toBeNull();
    expect(navigationLinks({ lat: 91, lng: 5 })).toBeNull();
    expect(navigationLinks({ lat: 43, lng: Number.POSITIVE_INFINITY })).toBeNull();
    expect(isValidPoint({ lat: -90, lng: 180 })).toBe(true);
  });
});

describe("telHref", () => {
  it("keeps digits and a leading plus", () => {
    expect(telHref("06 12 34 56 78")).toBe("tel:0612345678");
    expect(telHref("+33 6 12 34 56 78")).toBe("tel:+33612345678");
    expect(telHref(" 04.91.00.00.00 ")).toBe("tel:0491000000");
  });

  it("returns null without a usable number", () => {
    expect(telHref(null)).toBeNull();
    expect(telHref(undefined)).toBeNull();
    expect(telHref("")).toBeNull();
    expect(telHref("n/a")).toBeNull();
  });
});

describe("regulatorContact", () => {
  it("shows the stored number and dials its digits", () => {
    expect(regulatorContact("04 65 71 00 00")).toEqual({ number: "04 65 71 00 00", href: "tel:0465710000" });
  });

  it("gives no contact when no number is set", () => {
    expect(regulatorContact(null)).toBeNull();
    expect(regulatorContact(undefined)).toBeNull();
    expect(regulatorContact("")).toBeNull();
    expect(regulatorContact("  ")).toBeNull();
  });
});
