import { parse } from "acorn";
import * as semver from "semver";
import { isSafeSegment } from "./validate.js";

function extractProperty(node, name) {
  if (node.type !== "ObjectExpression") return undefined;
  const prop = node.properties.find((p) => {
    if (p.type !== "Property") return false;
    if (p.key.type === "Identifier") return p.key.name === name;
    if (p.key.type === "Literal") return p.key.value === name;
    return false;
  });
  if (!prop) return undefined;
  if (prop.value.type === "Literal") return prop.value.value;
  return undefined;
}

function isManifestKey(key) {
  return key === "manifest" || key === "meta";
}

function findManifestObject(stmts) {
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
        return node.expression.right;
      }
    }

    if (node.type === "VariableDeclaration") {
      for (const decl of node.declarations) {
        if (decl.id.type === "Identifier" && decl.id.name === "Fluorite") {
          if (decl.init?.type === "ObjectExpression") {
            const manifestProp = decl.init.properties.find((p) => {
              if (p.type !== "Property") return false;
              const keyName =
                p.key.type === "Identifier"
                  ? p.key.name
                  : p.key.type === "Literal"
                    ? p.key.value
                    : null;
              return isManifestKey(keyName);
            });
            if (manifestProp) return manifestProp.value;
          }
        }
      }
    }
  }
  return null;
}

function nestedStatements(node, out) {
  const push = (n) => {
    if (n && typeof n === "object") {
      if (
        n.type === "FunctionDeclaration" ||
        n.type === "FunctionExpression" ||
        n.type === "ArrowFunctionExpression"
      ) {
        if (n.body?.type === "BlockStatement") out.push(n.body.body);
      }
    }
  };
  push(node.expression?.callee ?? node);
  return out;
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

  for (const stmts of containers) {
    const obj = findManifestObject(stmts);
    if (obj && obj.type === "ObjectExpression") {
      const id = extractProperty(obj, "id");
      const name = extractProperty(obj, "name");
      const version = extractProperty(obj, "version");
      const license = extractProperty(obj, "license");
      const description = extractProperty(obj, "description");

      if (id && name && version) {
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
    }
  }

  throw new Error("No Fluorite manifest found in source");
}
