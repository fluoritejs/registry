import { parse } from "acorn";
import * as semver from "semver";
import { isSafeSegment } from "./validate.js";

function extractProperty(node, name) {
  if (node.type !== "ObjectExpression") return undefined;
  const props = node.properties.filter((p) => {
    if (p.type !== "Property") return false;
    if (p.key.type === "Identifier") return p.key.name === name;
    if (p.key.type === "Literal") return p.key.value === name;
    return false;
  });
  if (props.length > 1) {
    throw new Error(`Duplicate "${name}" in Fluorite manifest`);
  }
  const prop = props[0];
  if (!prop) return undefined;
  if (prop.value.type === "Literal") {
    const value = prop.value.value;
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

function isManifestKey(key) {
  return key === "manifest" || key === "meta";
}

function findManifestObject(stmts) {
  let found = null;
  const tooMany = (keyName) => {
    throw new Error(`Duplicate Fluorite.${keyName} definitions`);
  };
  for (const node of stmts) {
    if (
      node.type === "ExpressionStatement" &&
      node.expression.type === "AssignmentExpression"
    ) {
      const left = node.expression.left;
      if (
        left.type === "MemberExpression" &&
        left.object.type === "Identifier" &&
        left.object.name === "Fluorite" &&
        left.property.type === "Identifier" &&
        isManifestKey(left.property.name)
      ) {
        if (found) tooMany(left.property.name);
        found = node.expression.right;
      }
    }

    if (node.type === "VariableDeclaration") {
      for (const decl of node.declarations) {
        if (decl.id.type === "Identifier" && decl.id.name === "Fluorite") {
          if (decl.init?.type === "ObjectExpression") {
            const manifestProps = decl.init.properties.filter((p) => {
              if (p.type !== "Property") return false;
              const keyName =
                p.key.type === "Identifier"
                  ? p.key.name
                  : p.key.type === "Literal"
                    ? p.key.value
                    : null;
              return isManifestKey(keyName);
            });
            if (manifestProps.length > 1) tooMany("fluorite object");
            if (manifestProps.length === 1) {
              if (found) tooMany("fluorite object");
              found = manifestProps[0].value;
            }
          }
        }
      }
    }
  }
  return found;
}

const MAX_WALK_DEPTH = 4;

function statementsIn(node, depth, out) {
  if (!node || depth > MAX_WALK_DEPTH) return;
  if (node.type === "ParenthesizedExpression") {
    statementsIn(node.expression, depth + 1, out);
    return;
  }
  if (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  ) {
    if (node.body?.type === "BlockStatement") out.push(node.body.body);
    return;
  }
  if (node.type === "CallExpression") {
    statementsIn(node.callee, depth + 1, out);
    return;
  }
  if (node.type === "UnaryExpression") {
    statementsIn(node.argument, depth + 1, out);
    return;
  }
  if (node.type === "SequenceExpression" && node.expressions?.length) {
    statementsIn(node.expressions[node.expressions.length - 1], depth + 1, out);
    return;
  }
  if (node.type === "MemberExpression") {
    const propName =
      node.property?.type === "Identifier"
        ? node.property.name
        : node.property?.type === "Literal"
          ? node.property.value
          : null;
    if (propName === "call" || propName === "apply") {
      statementsIn(node.object, depth + 1, out);
    }
  }
}

function nestedStatements(node, out) {
  statementsIn(
    node.type === "ExpressionStatement" ? node.expression : node,
    0,
    out,
  );
}

export function extractManifest(source, packageIdPattern) {
  const ast = parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowReturnOutsideFunction: true,
    allowImportExportEverywhere: true,
  });

  // Collect statement lists starting at the top level, then descending into
  // function bodies. Compiled extensions wrap all code in an IIFE, so the
  // Fluorite declaration lives one level down.
  const containers = [ast.body];
  for (const node of ast.body) {
    if (
      node.type === "ExpressionStatement" &&
      node.expression.type === "CallExpression"
    ) {
      nestedStatements(node, containers);
    }
  }

  const candidates = containers
    .map(findManifestObject)
    .filter((obj) => obj && obj.type === "ObjectExpression");

  if (candidates.length > 1) {
    throw new Error("Duplicate Fluorite manifest definitions");
  }
  if (candidates.length === 0) {
    throw new Error("No Fluorite manifest found in source");
  }

  const obj = candidates[0];
  const id = extractProperty(obj, "id");
  const name = extractProperty(obj, "name");
  const version = extractProperty(obj, "version");
  const license = extractProperty(obj, "license");
  const description = extractProperty(obj, "description");

  if (!id || !name || !version) {
    throw new Error(
      "Fluorite manifest is missing required fields (id, name, version)",
    );
  }
  const pkgRe = new RegExp(packageIdPattern);
  if (!isSafeSegment(id)) {
    throw new Error(`Invalid extension id: ${id}`);
  }
  if (!pkgRe.test(id)) {
    throw new Error(`Invalid extension id: ${id}`);
  }
  if (!semver.valid(version)) {
    throw new Error(`Invalid version: ${version}`);
  }
  return {
    id,
    name,
    version,
    license: license || "",
    description: description || "",
  };
}
