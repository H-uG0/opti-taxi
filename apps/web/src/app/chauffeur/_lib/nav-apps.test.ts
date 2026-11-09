import { describe, expect, it } from "vitest";
import { navigationLinks } from "./links";
import { isApplePhone, isNavApp, navAppHref, navAppsFor } from "./nav-apps";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

describe("isApplePhone", () => {
  it("recognises an iPhone and an iPad that says it is a Mac", () => {
    expect(isApplePhone(IPHONE, "iPhone", 5)).toBe(true);
    expect(isApplePhone(MAC, "MacIntel", 5)).toBe(true);
    expect(isApplePhone(MAC, "MacIntel", 0)).toBe(false);
    expect(isApplePhone(ANDROID, "Linux armv8l", 5)).toBe(false);
  });
});

describe("navAppsFor", () => {
  it("offers Apple Plans instead of geo: on an iPhone", () => {
    expect(navAppsFor(true, null)).toEqual(["google", "waze", "apple"]);
    expect(navAppsFor(false, null)).toEqual(["google", "waze", "geo"]);
  });

  it("puts the app used last first, when this phone offers it", () => {
    expect(navAppsFor(false, "waze")).toEqual(["waze", "google", "geo"]);
    expect(navAppsFor(true, "apple")).toEqual(["apple", "google", "waze"]);
    // geo: remembered on an Android phone, now on an iPhone: default order.
    expect(navAppsFor(true, "geo")).toEqual(["google", "waze", "apple"]);
  });

  it("links each app to the same coordinates", () => {
    const links = navigationLinks({ lat: 44.1959, lng: 5.9436 });
    if (!links) throw new Error("links expected");
    expect(navAppHref("apple", links)).toBe("https://maps.apple.com/?daddr=44.1959,5.9436&dirflg=d");
    expect(navAppHref("geo", links)).toBe("geo:44.1959,5.9436?q=44.1959,5.9436");
    expect(navAppHref("waze", links)).toContain("ll=44.1959,5.9436");
    expect(navAppHref("google", links)).toContain("destination=44.1959,5.9436");
  });

  it("reads back only a known app from the phone's storage", () => {
    expect(isNavApp("waze")).toBe(true);
    expect(isNavApp("tomtom")).toBe(false);
    expect(isNavApp(null)).toBe(false);
  });
});
