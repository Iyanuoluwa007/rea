import * as t from "@babel/types";

import {
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  collectJavaScriptIdentityWritesSteps,
  electronMemberPath,
} from "./javascriptElectronMemberWrites.js";
import { createSemanticModuleInterop } from "./javascriptModuleInterop.js";
import {
  isUnshadowedGlobal,
  resolveSemanticBindingState,
  semanticStableInitializer,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticMemberEffect,
} from "./javascriptSemanticState.js";
import { isImportMetaUrl } from "./javascriptStaticAnalysisHelpers.js";
import { semanticMutationInitializers } from "./javascriptSemanticMutationInitializers.js";

const GLOBAL_OBJECT_NAMES = ["globalThis", "global", "window", "self"];

const globalObjectName = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): string | undefined =>
  GLOBAL_OBJECT_NAMES.find((name) => isUnshadowedGlobal(node, state, name));

/** Global self references retain object identity, rather than adding a property. */
const canonicalAmbientPath = (
  path: readonly (string | null)[],
): readonly (string | null)[] => {
  if (path[0] !== "global") return path;
  let firstProperty = 1;
  while (GLOBAL_OBJECT_NAMES.includes(path[firstProperty] ?? ""))
    firstProperty += 1;
  return ["global", ...path.slice(firstProperty)];
};

type AmbientPath = readonly (string | null)[];

/** Undefined means a cyclic or conflicting projection can select any depth. */
type AmbientProjection = AmbientPath | undefined;

/**
 * Follow local object identities without equating shallow copies with their
 * sources. Write lookup retains every visible initializer: reassigning an alias
 * later cannot erase a possible earlier mutation. Intrinsic reads stay strict.
 */
const createAmbientPathResolver = (
  state: JavaScriptSemanticAnalysisState,
  possibleWrites: boolean,
) => {
  const cached = new WeakMap<t.Node, readonly AmbientPath[]>();
  return (node: t.Node, capture?: t.Node): readonly AmbientPath[] => {
    const prior = possibleWrites ? undefined : cached.get(node);
    if (prior !== undefined) return prior;
    const result = new Map<string, AmbientPath>();
    // The caller's write site selects initializers for the written target.
    // Reads reached through an initializer occur at their own position.
    const pending: {
      node: t.Node;
      suffix: AmbientProjection;
      readsAtSelf?: true;
    }[] = [{ node, suffix: [] }];
    // Join projections at their producing expression, rather than enumerating
    // alias histories. Each key can only widen to a wildcard, and conflicting
    // depths widen to unknown, so diamonds and cycles have finite state.
    const expanded = new WeakMap<t.Node, AmbientProjection>();
    const retain = (path: AmbientPath) => {
      let canonical = canonicalAmbientPath(path);
      for (;;) {
        result.set(JSON.stringify(canonical), canonical);
        // An unknown key may select a global self reference as well as a
        // distinct property. Retain both possible object identities for writes.
        if (
          !possibleWrites ||
          canonical[0] !== "global" ||
          canonical[1] !== null
        )
          break;
        canonical = canonicalAmbientPath(["global", ...canonical.slice(2)]);
      }
    };
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined) break;
      const { root, members } = electronMemberPath(current.node);
      let suffix: AmbientProjection =
        current.suffix === undefined
          ? undefined
          : [...members, ...current.suffix];
      if (expanded.has(root)) {
        const previous = expanded.get(root);
        if (previous === undefined) continue;
        if (suffix !== undefined && previous.length === suffix.length) {
          const joined: AmbientPath = previous.map((key, index) =>
            key === suffix?.[index] ? key : null,
          );
          if (joined.every((key, index) => key === previous[index])) continue;
          suffix = joined;
        } else suffix = undefined;
        if (!possibleWrites) {
          cached.set(node, []);
          return [];
        }
      }
      expanded.set(root, suffix);
      // A widened projection is a possible write, never proof of an intrinsic.
      if (suffix === undefined && !possibleWrites) continue;
      const continueWith = (node: t.Node, path: AmbientProjection = suffix) =>
        pending.push({
          node,
          suffix: path,
          ...(current.readsAtSelf && { readsAtSelf: true }),
        });
      if (
        t.isMetaProperty(root) &&
        root.meta.name === "import" &&
        root.property.name === "meta"
      ) {
        retain(["import-meta", ...(suffix ?? [])]);
        continue;
      }
      if (t.isIdentifier(root)) {
        // The wrapper module object is distinct from globalThis.module. Keep
        // its identity through the same alias/projection owner used for writes.
        if (isUnshadowedGlobal(root, state, "module")) {
          retain(["commonjs-module", ...(suffix ?? [])]);
          continue;
        }
        if (globalObjectName(root, state) !== undefined) {
          retain(["global", ...(suffix ?? [])]);
          continue;
        }
        if (isUnshadowedGlobal(root, state, root.name)) {
          retain(["global", root.name, ...(suffix ?? [])]);
          continue;
        }
        const binding = resolveSemanticBindingState(state, root, root.name);
        if (binding === undefined) continue;
        const stable = semanticStableInitializer(binding, state);
        const readAt = current.readsAtSelf ? root : capture;
        const initializers = possibleWrites
          ? readAt === undefined
            ? binding.initializers
            : semanticMutationInitializers(binding, readAt, state.parentsByNode)
                .initializers
          : stable === undefined
            ? []
            : [stable];
        for (const initializer of initializers)
          pending.push({
            node: initializer.node,
            readsAtSelf: true,
            suffix:
              suffix === undefined
                ? undefined
                : [
                    ...initializer.projection.map((key) =>
                      key === null ? null : String(key),
                    ),
                    ...suffix,
                  ],
          });
        continue;
      }
      if (possibleWrites && t.isConditionalExpression(root)) {
        continueWith(root.consequent);
        continueWith(root.alternate);
        continue;
      }
      if (possibleWrites && t.isLogicalExpression(root)) {
        continueWith(root.left);
        continueWith(root.right);
        continue;
      }
      const key = suffix?.[0];
      if (suffix !== undefined && key === undefined) continue;
      if (t.isObjectExpression(root)) {
        if (possibleWrites) {
          for (const property of root.properties) {
            if (t.isSpreadElement(property)) continueWith(property.argument);
            else if (
              t.isObjectProperty(property) &&
              t.isExpression(property.value)
            ) {
              const ownKey = semanticStaticPropertyKey(
                property.key,
                property.computed,
              );
              if (
                suffix === undefined ||
                key === null ||
                ownKey === null ||
                ownKey === key
              )
                continueWith(property.value, suffix?.slice(1));
            }
          }
        } else if (
          suffix !== undefined &&
          key !== null &&
          root.properties.every(
            (property) =>
              t.isObjectProperty(property) &&
              semanticStaticPropertyKey(property.key, property.computed) !==
                null,
          )
        ) {
          const property = root.properties.findLast(
            (property) =>
              t.isObjectProperty(property) &&
              semanticStaticPropertyKey(property.key, property.computed) ===
                key,
          );
          if (t.isObjectProperty(property) && t.isExpression(property.value))
            continueWith(property.value, suffix.slice(1));
        }
      } else if (t.isArrayExpression(root)) {
        if (suffix === undefined) {
          for (const element of root.elements)
            if (t.isSpreadElement(element)) continueWith(element.argument);
            else if (t.isExpression(element)) continueWith(element);
        } else if (!root.elements.some(t.isSpreadElement)) {
          const index = Number(key);
          if (key === null && possibleWrites) {
            for (const element of root.elements)
              if (t.isExpression(element))
                continueWith(element, suffix.slice(1));
          } else if (
            key !== null &&
            Number.isInteger(index) &&
            index >= 0 &&
            String(index) === key
          ) {
            const element = root.elements[index];
            if (t.isExpression(element)) continueWith(element, suffix.slice(1));
          }
        }
      }
    }
    const paths = [...result.values()];
    if (!possibleWrites) cached.set(node, paths);
    return paths;
  };
};

/**
 * Index source-local writes through ambient identities and stable aliases.
 * The shared invocation owner resolves intrinsic aliases, bind/call/apply and
 * literal argument spreads. Runtime reachability and arbitrary call effects
 * remain unevaluated; a visible possible write is sufficient.
 */
export function* indexJavaScriptAmbientWritesSteps(
  program: t.Program,
  state: JavaScriptSemanticAnalysisState,
): Generator<void> {
  const ambientReads = createAmbientPathResolver(state, false);
  const ambientWrites = createAmbientPathResolver(state, true);
  const interop = createSemanticModuleInterop(state, {
    intrinsicPath: (node) => {
      const [path] = ambientReads(node);
      return path?.[0] === "global" && path.every((key) => key !== null)
        ? ["intrinsic", ...(path.slice(1) as readonly string[])]
        : undefined;
    },
  });
  yield* collectJavaScriptIdentityWritesSteps(
    program,
    (root, kind, writeSite) => {
      if (kind === "opaque-call") return [];
      // Reassigning a local alias changes the binding, not the referenced object.
      if (kind === "binding")
        return t.isIdentifier(root) &&
          isUnshadowedGlobal(root, state, root.name)
          ? [["global", root.name]]
          : [];
      return ambientWrites(root, writeSite);
    },
    interop.intrinsicInvocation,
    interop.staticString,
    interop.isFreshObject,
    (node, path) => {
      state.ambientWrites.retain(path);
      state.ambientWriteEffects.push({ path, node });
    },
  );
}

/**
 * How a global reference relates to visible source-local writes. A write under
 * an unknown key may or may not select the name, so it leaves the built-in
 * possible rather than replaced.
 */
type SemanticGlobalReferenceState =
  | "not-global"
  | "unmodified"
  | "possibly-replaced"
  | "replaced";

/** Exact written paths, indexed once per collected ambient write list. */
const exactAmbientWrites = new WeakMap<
  readonly JavaScriptSemanticMemberEffect[],
  { readonly length: number; readonly paths: ReadonlySet<string> }
>();

const exactAmbientWritePaths = (
  state: JavaScriptSemanticAnalysisState,
): ReadonlySet<string> => {
  const effects = state.ambientWriteEffects;
  const cached = exactAmbientWrites.get(effects);
  if (cached?.length === effects.length) return cached.paths;
  const paths = new Set<string>();
  for (const { path } of effects)
    if (path.every((key) => typeof key === "string" || typeof key === "number"))
      paths.add(JSON.stringify(path.map(String)));
  exactAmbientWrites.set(effects, { length: effects.length, paths });
  return paths;
};

/** Coverage is the prefix index; only an all-exact written prefix replaces. */
const ambientPathWrite = (
  state: JavaScriptSemanticAnalysisState,
  path: readonly string[],
): "none" | "possible" | "exact" => {
  if (!state.ambientWrites.covers(path)) return "none";
  const exact = exactAmbientWritePaths(state);
  for (let length = path.length; length > 0; length -= 1)
    if (exact.has(JSON.stringify(path.slice(0, length)))) return "exact";
  return "possible";
};

/**
 * Classify an ambient name, direct global-object property, or member path of
 * one, such as `JSON.parse`, against visible source-local overwrites. This is a
 * syntax-local identity fact, not proof that the runtime's globals have never
 * been patched by other code.
 */
const semanticGlobalReferenceState = (
  callee: t.Node,
  state: JavaScriptSemanticAnalysisState,
  name: string,
  members: readonly string[] = [],
): SemanticGlobalReferenceState => {
  const node = unwrapJavaScriptExpression(callee).node;
  const paths = [["global", name, ...members]];
  if (!isUnshadowedGlobal(node, state, name)) {
    if (
      !t.isMemberExpression(node) ||
      semanticStaticPropertyKey(node.property, node.computed) !== name
    )
      return "not-global";
    const root = unwrapJavaScriptExpression(node.object).node;
    const namespace = globalObjectName(root, state);
    if (namespace === undefined) return "not-global";
    paths.push(["global", namespace]);
  }
  const writes = paths.map((path) => ambientPathWrite(state, path));
  if (writes.includes("exact")) return "replaced";
  return writes.includes("possible") ? "possibly-replaced" : "unmodified";
};

/** Recognize a global reference without any visible source-local overwrite. */
export const isUnmodifiedGlobalReference = (
  callee: t.Node,
  state: JavaScriptSemanticAnalysisState,
  name: string,
): boolean =>
  semanticGlobalReferenceState(callee, state, name) === "unmodified";

/**
 * Resolve a built-in effect's identity: complete when unmodified, partial when
 * an unknown-key write may have replaced it, and null when not the built-in.
 */
export const semanticBuiltinGlobalResolution = (
  callee: t.Node,
  state: JavaScriptSemanticAnalysisState,
  name: string,
  members: readonly string[] = [],
): "complete" | "partial" | null => {
  const reference = semanticGlobalReferenceState(callee, state, name, members);
  if (reference === "unmodified") return "complete";
  return reference === "possibly-replaced" ? "partial" : null;
};

/** A module URL base is known only while its property has no visible write. */
export const isUnmodifiedImportMetaUrl = (
  node: t.Node | undefined,
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  isImportMetaUrl(node) && !state.ambientWrites.covers(["import-meta", "url"]);
