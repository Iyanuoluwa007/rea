import { expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

/** Group event methods by emitter key, keeping each operation's resolution. */
const emitters = (source: string) => {
  const groups = new Map<string, string[]>();
  for (const { emitterKey, method, resolution } of analyzeJavaScriptSemantics(
    source,
  ).eventOperations)
    groups.set(emitterKey, [
      ...(groups.get(emitterKey) ?? []),
      `${method}:${resolution}`,
    ]);
  return [...groups.values()];
};

it("keeps this receivers of unrelated classes in separate emitters", () => {
  expect(
    emitters(`
      import { EventEmitter } from "node:events";
      class Producer extends EventEmitter {
        run() { this.on("ready", () => {}); }
      }
      class Unrelated extends EventEmitter {
        run() { this.emit("ready"); }
      }
      const stable = new EventEmitter();
      stable.on("ready", () => {});
      stable.emit("ready");
    `),
  ).toEqual([
    ["on:complete"],
    ["emit:complete"],
    ["on:complete", "emit:complete"],
  ]);
});

it("shares one class receiver across its members", () => {
  expect(
    emitters(`
      class Service extends EventEmitter {
        constructor() { super(); this.on("ready", () => {}); }
        start() { this.emit("ready"); }
        stop = () => this.off("ready");
      }
    `),
  ).toEqual([["on:complete", "emit:complete", "off:complete"]]);
});

it("keeps a local class hierarchy as one candidate receiver", () => {
  expect(
    emitters(`
      class Base extends EventEmitter { run() { this.on("ready", () => {}); } }
      class Child extends Base { start() { this.emit("ready"); } }
    `),
  ).toEqual([["on:partial", "emit:partial"]]);
});

it("scopes this to the function or object that binds it", () => {
  expect(
    emitters(`
      class Owner extends EventEmitter {
        run() {
          this.on("ready", () => {});
          function detached() { this.emit("ready"); }
          const nested = () => this.emit("ready");
        }
      }
      const host = {
        open() { this.on("ready", () => {}); },
        close: function () { this.emit("ready"); },
      };
      this.emit("ready");
    `),
  ).toEqual([
    ["on:complete", "emit:complete"],
    ["emit:complete"],
    ["on:complete", "emit:complete"],
    ["emit:complete"],
  ]);
});

it("keeps static members apart from instances", () => {
  expect(
    emitters(`
      class Registry extends EventEmitter {
        static boot() { this.emit("ready"); }
        run() { this.on("ready", () => {}); }
      }
    `),
  ).toEqual([["emit:complete"], ["on:complete"]]);
});
