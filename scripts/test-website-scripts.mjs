// Run the website's browser scripts against a small document model, so missing
// page-owned messages are checked without a browser.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const ASSETS = new URL("../website/public/assets/", import.meta.url);

class Element {
  constructor(tag, attributes = {}, children = [], text = "") {
    this.tagName = tag.toUpperCase();
    this.attributes = new Map(Object.entries(attributes));
    this.children = [];
    this.parent = null;
    this.listeners = new Map();
    this.ownText = text;
    this.hidden = "hidden" in attributes;
    this.disabled = "disabled" in attributes;
    this.checked = "checked" in attributes;
    this.value = attributes.value ?? "";
    for (const child of children) this.append(child);
  }

  append(child) {
    child.parent = this;
    this.children.push(child);
  }

  get textContent() {
    return (
      this.ownText + this.children.map((child) => child.textContent).join("")
    );
  }

  set textContent(value) {
    this.ownText = String(value);
    this.children = [];
  }

  get id() {
    return this.getAttribute("id") ?? "";
  }

  get lang() {
    return this.getAttribute("lang") ?? "";
  }

  get dataset() {
    const values = {};
    for (const [name, value] of this.attributes) {
      if (!name.startsWith("data-")) continue;
      const key = name
        .slice(5)
        .replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      values[key] = value;
    }
    return values;
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  addEventListener(type, listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ preventDefault() {}, repeat: false, ...event });
    }
  }

  click() {
    this.dispatch("click");
  }

  focus() {}

  descendants() {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }

  matches(selector) {
    return selector
      .split(",")
      .some((part) => matchesComplex(this, part.trim()));
  }

  closest(selector) {
    for (let node = this; node !== null; node = node.parent) {
      if (node.matches(selector)) return node;
    }
    return null;
  }

  querySelectorAll(selector) {
    return this.descendants().filter((node) => node.matches(selector));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  getContext() {
    return this.context ?? null;
  }
}

// Supports the selector forms the website scripts use: tag, #id, .class and
// [attribute], [attribute="value"] or [attribute^="value"], joined by spaces.
function matchesCompound(node, compound) {
  const pattern =
    /^([a-z0-9]*)((?:#[\w-]+|\.[\w-]+|\[[\w-]+(?:\^?="[^"]*")?\])*)$/i;
  const parsed = pattern.exec(compound);
  if (parsed === null) throw new Error(`Unsupported selector: ${compound}`);
  const [, tag, rest] = parsed;
  if (tag && node.tagName !== tag.toUpperCase()) return false;
  for (const [, id, className, name, operator, value] of rest.matchAll(
    /#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:(\^?=)"([^"]*)")?\]/g,
  )) {
    if (id !== undefined) {
      if (node.id !== id) return false;
      continue;
    }
    if (className !== undefined) {
      const classes = (node.getAttribute("class") ?? "").split(/\s+/);
      if (!classes.includes(className)) return false;
      continue;
    }
    const actual = node.getAttribute(name);
    if (actual === null) return false;
    if (operator === "=" && actual !== value) return false;
    if (operator === "^=" && !actual.startsWith(value)) return false;
  }
  return true;
}

function matchesComplex(node, selector) {
  const parts = selector.split(/\s+/);
  if (!matchesCompound(node, parts.at(-1))) return false;
  let ancestor = node.parent;
  for (const part of parts.slice(0, -1).reverse()) {
    while (ancestor !== null && !matchesCompound(ancestor, part))
      ancestor = ancestor.parent;
    if (ancestor === null) return false;
    ancestor = ancestor.parent;
  }
  return true;
}

const h = (tag, attributes, ...children) => {
  const text = children.filter((child) => typeof child === "string").join("");
  return new Element(
    tag,
    attributes ?? {},
    children.filter((child) => child instanceof Element),
    text,
  );
};

// Install a fresh document and browser globals, then run one script.
async function run(
  script,
  body,
  { lang = "en", clipboard = "resolve", stars = 1234 } = {},
) {
  const root = h("html", { lang }, h("body", {}, ...body));
  const timers = [];
  const written = [];
  const canvasText = [];
  for (const canvas of root.querySelectorAll("canvas")) {
    canvas.context = new Proxy(
      { fillText: (text) => canvasText.push(text) },
      { get: (target, name) => target[name] ?? (() => {}), set: () => true },
    );
  }
  const document = {
    documentElement: root,
    hidden: false,
    getElementById: (id) =>
      root.descendants().find((node) => node.id === id) ?? null,
    querySelector: (selector) => root.querySelector(selector),
    querySelectorAll: (selector) => root.querySelectorAll(selector),
    createRange: () => ({ selectNodeContents() {} }),
    addEventListener() {},
  };
  const window = {
    scrollY: 0,
    innerHeight: 900,
    location: { hash: "" },
    addEventListener() {},
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    requestAnimationFrame: () => 1,
    scrollTo() {},
    setTimeout: (callback) => timers.push(callback),
  };
  Object.assign(globalThis, {
    document,
    window,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    Path2D: class {},
    fetch: async () => ({
      ok: true,
      json: async () => ({ stargazers_count: stars }),
    }),
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      clipboard: {
        writeText: async (text) => {
          if (clipboard === "reject") throw new Error("denied");
          written.push(text);
        },
      },
    },
  });
  await import(
    `${pathToFileURL(new URL(script, ASSETS).pathname)}?load=${randomUUID()}`
  );
  await nextTurn();
  return { root, timers, written, canvasText };
}

const copyBlock = () => [
  h("button", { "data-copy": "command" }, "Copy"),
  h("pre", {}, h("code", { id: "command" }, "npx rea-agents setup")),
];
const copyStatus = (messages = {}) =>
  h("p", {
    id: "copy-status",
    ...Object.fromEntries(
      Object.entries(messages).map(([key, value]) => [`data-${key}`, value]),
    ),
  });
const englishCopyMessages = {
  copied: "Copied",
  selected: "Selected",
  "status-copied": "Code copied to clipboard.",
  "status-selected": "Code selected. Use your keyboard to copy it.",
};

test("copy buttons report and restore localized labels", async () => {
  const { root, timers, written } = await run("main.js", [
    ...copyBlock(),
    copyStatus(englishCopyMessages),
  ]);
  const button = root.querySelector("[data-copy]");
  button.click();
  await nextTurn();
  assert.deepEqual(written, ["npx rea-agents setup"]);
  assert.equal(button.textContent, "Copied");
  assert.equal(
    root.querySelector("#copy-status").textContent,
    "Code copied to clipboard.",
  );
  timers.forEach((callback) => callback());
  assert.equal(button.textContent, "Copy");
});

test("copy buttons keep their label when messages are missing", async () => {
  for (const [body, clipboard] of [
    [[...copyBlock(), copyStatus()], "resolve"],
    [[...copyBlock(), copyStatus()], "reject"],
    [
      [...copyBlock(), copyStatus({ copied: "", "status-copied": "" })],
      "resolve",
    ],
    [copyBlock(), "resolve"],
  ]) {
    const { root, timers, written } = await run("main.js", body, { clipboard });
    const button = root.querySelector("[data-copy]");
    button.click();
    await nextTurn();
    assert.equal(written.length, clipboard === "resolve" ? 1 : 0);
    assert.equal(button.textContent, "Copy");
    assert.equal(root.querySelector("#copy-status")?.textContent ?? "", "");
    timers.forEach((callback) => callback());
    assert.equal(button.textContent, "Copy");
  }
});

const githubLink = (labels = {}) =>
  h(
    "a",
    {
      class: "nav-github",
      "aria-label": "REA on GitHub",
      title: "REA on GitHub",
      ...labels,
    },
    h("span", { class: "nav-github-count", hidden: "" }),
  );

test("the star label follows the page language and plural rules", async () => {
  const labels = {
    "data-label-one": "REA on GitHub ({count} star)",
    "data-label-other": "REA on GitHub ({count} stars)",
  };
  for (const [stars, lang, expected] of [
    [1, "en", "REA on GitHub (1 star)"],
    [1234, "en", "REA on GitHub (1,234 stars)"],
    [1234, "de", "REA on GitHub (1.234 stars)"],
  ]) {
    const { root } = await run("main.js", [githubLink(labels)], {
      stars,
      lang,
    });
    await nextTurn();
    assert.equal(
      root.querySelector(".nav-github").getAttribute("aria-label"),
      expected,
    );
  }
  // Languages without a "one" category use the "other" label.
  const { root } = await run(
    "main.js",
    [githubLink({ "data-label-other": "{count}" })],
    { stars: 1, lang: "ja" },
  );
  await nextTurn();
  assert.equal(
    root.querySelector(".nav-github").getAttribute("aria-label"),
    "1",
  );
});

test("the star label stays unchanged without a localized label", async () => {
  const { root } = await run("main.js", [githubLink()], { stars: 1 });
  await nextTurn();
  const link = root.querySelector(".nav-github");
  assert.equal(link.getAttribute("aria-label"), "REA on GitHub");
  assert.equal(link.getAttribute("title"), "REA on GitHub");
  assert.equal(link.querySelector(".nav-github-count").hidden, true);
});

const percentDemo = (messages) =>
  h(
    "figure",
    { "data-percent-demo": "", ...messages },
    h(
      "div",
      { class: "percent-operation", hidden: "" },
      h(
        "button",
        { "data-percent-operation": "add", "aria-pressed": "true" },
        "200 + 10%",
      ),
      h(
        "button",
        { "data-percent-operation": "multiply", "aria-pressed": "false" },
        "200 × 10%",
      ),
    ),
    h("span", { "data-percent-expression": "" }, "200 +"),
    h("strong", { "data-percent-display": "" }, "20"),
    h(
      "div",
      { class: "percent-controls", hidden: "" },
      h("button", { "data-percent-key": "percent" }, "%"),
      h("button", { "data-percent-key": "equals", disabled: "" }, "="),
      h("button", { "data-percent-key": "reset" }, "Reset"),
    ),
    h(
      "p",
      { "data-percent-status": "" },
      "10% of 200 = 20. Then 200 + 20 = 220.",
    ),
  );

test("the percent demo uses page messages and keeps text when one is missing", async () => {
  const { root } = await run("home.js", [
    percentDemo({
      "data-msg-input": "Press % to see what happens to 10.",
      "data-msg-result": "200 {operator} {percent} = {result}.",
    }),
  ]);
  const status = root.querySelector("[data-percent-status]");
  const key = (name) =>
    root.querySelector(`[data-percent-key="${name}"]`).click();
  assert.equal(status.textContent, "Press % to see what happens to 10.");
  key("percent");
  assert.equal(status.textContent, "Press % to see what happens to 10.");
  key("equals");
  assert.equal(status.textContent, "200 + 20 = 220.");

  const bare = await run("home.js", [percentDemo({})]);
  const bareStatus = bare.root.querySelector("[data-percent-status]");
  for (const name of ["percent", "equals", "reset"]) {
    bare.root.querySelector(`[data-percent-key="${name}"]`).click();
    assert.equal(
      bareStatus.textContent,
      "10% of 200 = 20. Then 200 + 20 = 220.",
    );
  }
});

const dinoDemo = (messages) =>
  h(
    "figure",
    { "data-dino-demo": "", ...messages },
    h("svg", { class: "dino-fallback" }),
    h("canvas", { hidden: "" }),
    h(
      "div",
      { class: "dino-controls", hidden: "" },
      h("button", { "data-dino-start": "" }, "Play"),
      h("button", { "data-dino-jump": "" }, "Jump ↑"),
      h("button", { "data-dino-reset": "" }, "Restart"),
      h("output", { "data-dino-speed": "" }, "6.0"),
      h("input", { "data-dino-slider": "", value: "6" }),
      h("input", { "data-dino-auto": "", checked: "" }),
    ),
    h(
      "p",
      { "data-dino-status": "" },
      "Original rule: start at 6, then increase toward 13.",
    ),
  );

test("the dinosaur game never shows a missing message", async () => {
  const { root, canvasText } = await run("dino-demo.js", [
    dinoDemo({}),
    h("button", { "data-speed-check": "", hidden: "" }, "Replay"),
    h("p", { "data-speed-check-status": "" }, "Not replayed yet."),
  ]);
  const start = root.querySelector("[data-dino-start]");
  const status = root.querySelector("[data-dino-status]");
  const slider = root.querySelector("[data-dino-slider]");
  start.click();
  start.click();
  slider.value = "9.5";
  slider.dispatch("input");
  root.querySelector("[data-dino-reset]").click();
  assert.equal(start.textContent, "Play");
  assert.equal(
    status.textContent,
    "Original rule: start at 6, then increase toward 13.",
  );
  assert.deepEqual(canvasText, []);
  root.querySelector("[data-speed-check]").click();
  assert.equal(
    root.querySelector("[data-speed-check-status]").textContent,
    "Not replayed yet.",
  );
});

test("the dinosaur game fills placeholders from page messages", async () => {
  const { root, canvasText } = await run("dino-demo.js", [
    dinoDemo({
      "data-msg-pause": "Pause",
      "data-msg-fixed-running":
        "Fixed speed: {speed}. Space or Jump clears a cactus.",
      "data-msg-distance": "DISTANCE {distance}",
    }),
  ]);
  const start = root.querySelector("[data-dino-start]");
  const slider = root.querySelector("[data-dino-slider]");
  start.click();
  assert.equal(start.textContent, "Pause");
  slider.value = "9.5";
  slider.dispatch("input");
  assert.equal(
    root.querySelector("[data-dino-status]").textContent,
    "Fixed speed: 9.5. Space or Jump clears a cactus.",
  );
  assert.ok(canvasText.includes("DISTANCE 0000"));
});
