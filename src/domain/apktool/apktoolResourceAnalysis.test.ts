import { describe, expect, it } from "vitest";

import { qualifiedResourceLocale } from "./apktoolResourceAnalysis.js";

describe("qualified Android resource locales", () => {
  it.each([
    ["en-rUS-v21", "en-rUS"],
    ["b+zh+Hans+CN-night", "b+zh+Hans+CN"],
    ["pt-rBR-sw600dp", "pt-rBR"],
    ["fr-land", "fr"],
    ["mcc310-fr", "fr"],
    ["mcc310-mnc004-en-rUS-v21", "en-rUS"],
  ])("finds the locale in values-%s", (suffix, locale) => {
    expect(qualifiedResourceLocale(suffix)).toBe(locale);
  });

  it.each([
    "de",
    "pt-rBR",
    "b+sr+Latn",
    "night",
    "car-night",
    "v21",
    "sw600dp-land",
    "mcc310",
  ])("reports no qualified locale for values-%s", (suffix) => {
    expect(qualifiedResourceLocale(suffix)).toBeUndefined();
  });
});
