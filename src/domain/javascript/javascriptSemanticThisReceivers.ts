import * as t from "@babel/types";

import { semanticClassCandidates } from "./javascriptSemanticObjectReferences.js";
import type { JavaScriptSemanticAnalysisState } from "./javascriptSemanticState.js";

type SemanticClass = t.ClassDeclaration | t.ClassExpression;

/** A `this` receiver scoped to the class, object, function, or program binding it. */
export interface SemanticThisReceiver {
  readonly key: string;
  /** The class whose instances or constructor supply this receiver. */
  readonly klass: SemanticClass | null;
}

const nodeKey = (node: t.Node): string =>
  `${String(node.start ?? -1)}:${String(node.end ?? -1)}`;

const isComputedMemberKey = (owner: t.Node, child: t.Node): boolean =>
  (t.isClassMethod(owner) ||
    t.isClassPrivateMethod(owner) ||
    t.isObjectMethod(owner) ||
    t.isClassProperty(owner) ||
    t.isClassAccessorProperty(owner)) &&
  owner.key === child;

/**
 * Scope `this` receivers to the owner that binds them. A class member's
 * receiver is shared by its local class hierarchy, since a base method may run
 * on a subclass instance; a hierarchy with several classes, or an ambiguous
 * base, only identifies a candidate receiver.
 */
export const createSemanticThisReceivers = (
  state: JavaScriptSemanticAnalysisState,
) => {
  const roots = new Map<SemanticClass, SemanticClass>();
  const classes: SemanticClass[] = [];
  // Hierarchy sizes are resolved only when a class receiver needs them.
  let familySizes: Map<SemanticClass, number> | undefined;
  const ambiguous = new Set<SemanticClass>();
  const rootOf = (klass: SemanticClass): SemanticClass => {
    const cached = roots.get(klass);
    if (cached !== undefined) return cached;
    const seen = new Set<SemanticClass>([klass]);
    let current = klass;
    while (current.superClass != null) {
      const bases = semanticClassCandidates(current.superClass, state);
      if (bases.length > 1) ambiguous.add(klass);
      const base = bases.length === 1 ? bases[0] : undefined;
      if (base === undefined || seen.has(base)) break;
      seen.add(base);
      current = base;
    }
    roots.set(klass, current);
    return current;
  };
  const classReceiver = (
    klass: SemanticClass,
    isStatic: boolean,
  ): SemanticThisReceiver => ({
    key: `this:class:${nodeKey(rootOf(klass))}:${isStatic ? "static" : "instance"}`,
    klass,
  });
  const receiverOwner = (owner: t.Node): SemanticThisReceiver | undefined => {
    const parent = state.parentsByNode.get(owner);
    if (t.isClassMethod(owner) || t.isClassPrivateMethod(owner)) {
      const klass = parent && state.parentsByNode.get(parent);
      return klass !== undefined && t.isClass(klass)
        ? classReceiver(klass, owner.static)
        : undefined;
    }
    if (
      t.isObjectMethod(owner) ||
      (t.isFunctionExpression(owner) &&
        t.isObjectProperty(parent) &&
        parent.value === owner)
    ) {
      const object = t.isObjectMethod(owner)
        ? parent
        : parent && state.parentsByNode.get(parent);
      if (object !== undefined && t.isObjectExpression(object))
        return { key: `this:object:${nodeKey(object)}`, klass: null };
    }
    return undefined;
  };
  return {
    /** Record every class so hierarchy sizes are known after traversal. */
    record: (klass: SemanticClass): void => {
      classes.push(klass);
    },
    receiver: (node: t.ThisExpression): SemanticThisReceiver => {
      let child: t.Node = node;
      let owner = state.parentsByNode.get(node);
      while (owner !== undefined) {
        if (isComputedMemberKey(owner, child)) {
          // A computed key evaluates in the enclosing scope.
        } else if (t.isFunction(owner) && !t.isArrowFunctionExpression(owner)) {
          return (
            receiverOwner(owner) ?? {
              key: `this:function:${nodeKey(owner)}`,
              klass: null,
            }
          );
        } else if (
          t.isClassProperty(owner) ||
          t.isClassPrivateProperty(owner) ||
          t.isClassAccessorProperty(owner) ||
          t.isStaticBlock(owner)
        ) {
          // Field initializers and static blocks run with the class receiver.
          const body = state.parentsByNode.get(owner);
          const klass = body && state.parentsByNode.get(body);
          if (klass !== undefined && t.isClass(klass))
            return classReceiver(klass, t.isStaticBlock(owner) || owner.static);
        }
        child = owner;
        owner = state.parentsByNode.get(owner);
      }
      return { key: "this:program", klass: null };
    },
    /** A receiver is exact only for a lone class with an unambiguous base. */
    exact: (klass: SemanticClass): boolean => {
      if (familySizes === undefined) {
        familySizes = new Map();
        for (const member of classes) {
          const root = rootOf(member);
          familySizes.set(root, (familySizes.get(root) ?? 0) + 1);
        }
      }
      const root = rootOf(klass);
      return !ambiguous.has(klass) && familySizes.get(root) === 1;
    },
  };
};
