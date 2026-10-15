import { expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

const effects = (source: string) => {
  const ir = analyzeJavaScriptSemantics(source);
  return {
    timers: ir.timerOperations.map(
      ({ method, resolution }) => `${method}:${resolution}`,
    ),
    requests: ir.requestOperations
      .filter(({ kind }) => kind === "request")
      .map(({ method, resolution }) => `${method}:${resolution}`),
    parses: ir.boundaryOperations
      .filter(({ kind }) => kind === "parse")
      .map(({ method, resolution }) => `${method}:${resolution}`),
  };
};

const calls = `
  function work() {}
  setTimeout(work, 100);
  fetch("https://example.invalid");
  JSON.parse("null");
`;

it("does not classify calls to replaced globals as built-in effects", () => {
  expect(
    effects(`
      setTimeout = () => null;
      fetch = () => null;
      JSON.parse = () => null;
      ${calls}
    `),
  ).toEqual({ timers: [], requests: [], parses: ["parse:partial"] });
});

it("keeps built-in effects partial after a write under an unknown key", () => {
  expect(
    effects(`
      globalThis[Symbol.for("registry")] = new Map();
      ${calls}
    `),
  ).toEqual({
    timers: ["setTimeout:partial"],
    requests: ["fetch:partial"],
    parses: ["JSON.parse:partial"],
  });
});

it("keeps built-in effects for unmodified globals", () => {
  expect(effects(calls)).toEqual({
    timers: ["setTimeout:complete"],
    requests: ["fetch:complete"],
    parses: ["JSON.parse:complete"],
  });
});
