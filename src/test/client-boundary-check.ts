import path from "node:path";
import ts from "typescript";

// A static guard for the server-to-client prop boundary. Next serialises the props a Server
// Component passes to a "use client" component; a React component (a Lucide icon), a function or a
// class instance cannot cross. Unit tests and `next build` cannot see this for dynamic pages, so
// this check scans the JSX text instead. It is deliberately conservative: it flags only values
// that are obviously not serialisable.

export type SourceMap = Record<string, string>; // posix path relative to the repo root -> source

export interface BoundaryViolation {
  file: string;
  component: string;
  prop: string;
  reason: string;
}

const EXTENSIONS = [".tsx", ".ts"];
// Props that may legitimately carry a Server Action.
const ACTION_PROPS = new Set(["action", "formAction"]);
// Props that carry a component or icon by convention.
const COMPONENT_PROPS = new Set(["icon", "component", "as", "render"]);

function parse(file: string, source: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}

export function hasUseClient(source: string): boolean {
  const sf = parse("x.tsx", source);
  for (const statement of sf.statements) {
    if (
      !ts.isExpressionStatement(statement) ||
      !ts.isStringLiteral(statement.expression)
    ) {
      return false;
    }
    if (statement.expression.text === "use client") return true;
  }
  return false;
}

function resolveSpecifier(
  from: string,
  specifier: string,
  files: SourceMap,
): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = `src/${specifier.slice(2)}`;
  else if (specifier.startsWith("."))
    base = path.posix.join(path.posix.dirname(from), specifier);
  else return null;
  for (const candidate of [
    base,
    ...EXTENSIONS.map((ext) => base + ext),
    ...EXTENSIONS.map((ext) => `${base}/index${ext}`),
  ]) {
    if (candidate in files) return candidate;
  }
  return null;
}

interface ImportInfo {
  module: string; // raw specifier
  resolved: string | null;
}

function importsOf(
  file: string,
  sf: ts.SourceFile,
  files: SourceMap,
): Map<string, ImportInfo> {
  const map = new Map<string, ImportInfo>();
  for (const statement of sf.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const clause = statement.importClause;
    if (!clause || clause.phaseModifier === ts.SyntaxKind.TypeKeyword) continue;
    const specifier = statement.moduleSpecifier.text;
    const info = {
      module: specifier,
      resolved: resolveSpecifier(file, specifier, files),
    };
    if (clause.name) map.set(clause.name.text, info);
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) map.set(bindings.name.text, info);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (!element.isTypeOnly) map.set(element.name.text, info);
      }
    }
  }
  return map;
}

function rootIdentifier(node: ts.Expression): ts.Identifier | null {
  let current: ts.Expression = node;
  for (;;) {
    if (ts.isIdentifier(current)) return current;
    if (
      ts.isPropertyAccessExpression(current) ||
      ts.isElementAccessExpression(current) ||
      ts.isCallExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isParenthesizedExpression(current)
    ) {
      current = current.expression;
    } else return null;
  }
}

// Resolves a callback parameter (`items.map((item) => ...)`) to the identifier it iterates.
function iteratedIdentifier(param: ts.Identifier): ts.Identifier | null {
  let node: ts.Node = param.parent;
  while (!(ts.isArrowFunction(node) || ts.isFunctionExpression(node))) {
    if (ts.isSourceFile(node)) return null;
    node = node.parent;
  }
  const fn = node;
  if (!fn.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === param.text))
    return null;
  const call = fn.parent;
  if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression))
    return null;
  return rootIdentifier(call.expression.expression);
}

function describeIdentifier(
  id: ts.Identifier,
  imports: Map<string, ImportInfo>,
  files: SourceMap,
  trace: Set<string>,
): string | null {
  if (trace.has(id.text)) return null;
  trace.add(id.text);
  const info = imports.get(id.text);
  if (info) {
    if (info.module === "lucide-react") return `${id.text} is a Lucide icon component`;
    if (info.resolved) {
      const source = files[info.resolved] ?? "";
      if (/from\s+["']lucide-react["']/.test(source) && !hasUseClient(source)) {
        return `${id.text} comes from ${info.module}, which holds Lucide icon components`;
      }
    }
    return null;
  }
  const iterated = iteratedIdentifier(id);
  return iterated ? describeIdentifier(iterated, imports, files, trace) : null;
}

function checkValue(
  value: ts.Expression,
  prop: string,
  imports: Map<string, ImportInfo>,
  files: SourceMap,
  isSpread: boolean,
): string | null {
  const expr = ts.isParenthesizedExpression(value) ? value.expression : value;
  if (
    !isSpread &&
    (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) &&
    !ACTION_PROPS.has(prop)
  ) {
    return "an inline function cannot be passed to a Client Component (only a Server Action can)";
  }
  if (ts.isNewExpression(expr)) return "a class instance cannot cross the boundary";
  if (
    ts.isIdentifier(expr) ||
    ts.isPropertyAccessExpression(expr) ||
    ts.isElementAccessExpression(expr)
  ) {
    const root = rootIdentifier(expr);
    // `item.href` of a tainted `item` is plain data; only the bare object or its icon is not.
    const leaf = ts.isPropertyAccessExpression(expr) ? expr.name.text : null;
    if (root) {
      const reason =
        leaf === null || COMPONENT_PROPS.has(leaf)
          ? describeIdentifier(root, imports, files, new Set())
          : null;
      if (reason) return reason;
      if (
        !isSpread &&
        imports.has(root.text) &&
        COMPONENT_PROPS.has(prop) &&
        ts.isIdentifier(expr)
      ) {
        return `${root.text} is passed as \`${prop}\`, which looks like a component`;
      }
    }
  }
  if (ts.isObjectLiteralExpression(expr)) {
    for (const property of expr.properties) {
      if (ts.isMethodDeclaration(property))
        return "an object with a method cannot cross the boundary";
      let reason: string | null = null;
      if (ts.isSpreadAssignment(property)) {
        reason = checkValue(property.expression, prop, imports, files, true);
      } else if (ts.isPropertyAssignment(property)) {
        reason = checkValue(property.initializer, prop, imports, files, false);
      } else if (ts.isShorthandPropertyAssignment(property)) {
        reason = describeIdentifier(property.name, imports, files, new Set());
      }
      if (reason) return reason;
    }
  }
  return null;
}

// The server-side files: no "use client" directive and not imported (transitively) by a client
// module, which would pull them into the client bundle.
function serverFiles(files: SourceMap): string[] {
  const graph = new Map<string, string[]>();
  for (const [file, source] of Object.entries(files)) {
    const resolved = [...importsOf(file, parse(file, source), files).values()]
      .map((info) => info.resolved)
      .filter((r): r is string => r !== null);
    graph.set(file, resolved);
  }
  const clientSide = new Set<string>();
  const queue = Object.keys(files).filter((file) => hasUseClient(files[file]));
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (clientSide.has(file)) continue;
    clientSide.add(file);
    queue.push(...(graph.get(file) ?? []));
  }
  return Object.keys(files).filter(
    (file) => !clientSide.has(file) && file.endsWith(".tsx"),
  );
}

export function checkClientBoundary(files: SourceMap): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  const clientModules = new Set(Object.keys(files).filter((f) => hasUseClient(files[f])));
  for (const file of serverFiles(files)) {
    const sf = parse(file, files[file]);
    const imports = importsOf(file, sf, files);
    const visit = (node: ts.Node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(sf);
        const info = imports.get(tag.split(".")[0] ?? tag);
        if (info?.resolved && clientModules.has(info.resolved)) {
          for (const attribute of node.attributes.properties) {
            if (ts.isJsxSpreadAttribute(attribute)) {
              const reason = checkValue(
                attribute.expression,
                "...",
                imports,
                files,
                true,
              );
              if (reason)
                violations.push({ file, component: tag, prop: "...spread", reason });
              continue;
            }
            const init = attribute.initializer;
            if (!init || !ts.isJsxExpression(init) || !init.expression) continue;
            const prop = attribute.name.getText(sf);
            if (prop === "key") continue;
            const reason = checkValue(init.expression, prop, imports, files, false);
            if (reason) violations.push({ file, component: tag, prop, reason });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return violations;
}
