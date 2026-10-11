import { describe, expect, it } from "vitest";
import { SITE_LINKS } from "./site-links";

describe("QR destinations", () => {
  it("opens the main page at the supplied domain", () => {
    expect(SITE_LINKS[0].url).toBe("https://petrogrid.xyz");
  });
  it("opens the demo at the supplied subdomain", () => {
    expect(SITE_LINKS[1].url).toBe("https://demo.petrogrid.xyz");
  });
});