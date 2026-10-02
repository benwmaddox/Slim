import {compileDetailed, parseProgram, INTRINSICS, MATH_IMPORTS} from "./compiler.mjs";

const SVG_METADATA_BUILTIN = "svg_group";
const SVG_TRI_BUILTIN = "svg_tri";
const BUILTIN_NAMES = new Set(["tri", "sound", "input", SVG_METADATA_BUILTIN, SVG_TRI_BUILTIN]);

function safeName(name) {
  return name.replace(/[^A-Za-z0-9_$]/g, "_");
}

function backendError(message, node) {
  const token = node?.token;
  const line = token?.line ?? 1;
  const column = token?.column ?? 1;
  throw new SyntaxError(`Slim JavaScript compile error at ${line}:${column}: ${message}`);
}

function collectLayout(fn, useF32) {
  const locals = new Map();
  const parameters = [];
  for (let index = 0; index < fn.params.length; index += 1) {
    const generated = `p_${safeName(fn.params[index].name)}_${index}`;
    parameters.push(generated);
    locals.set(fn.params[index].name, generated);
  }

  const declarations = [];
  const collectDeclarations = (statements) => {
    for (const statement of statements) {
      if (statement.kind === "let") {
        const generated = `l_${safeName(statement.name)}_${declarations.length}`;
        declarations.push(generated);
        locals.set(statement.name, generated);
      } else if (statement.kind === "block") {
        collectDeclarations(statement.body);
      } else if (statement.kind === "if") {
        collectDeclarations(statement.thenBlock.body);
        if (statement.elseBlock) collectDeclarations(statement.elseBlock.body);
      } else if (statement.kind === "while") {
        collectDeclarations(statement.body.body);
      }
    }
  };
  collectDeclarations(fn.body);

  const moduloTemps = new Map();
  let moduloCount = 0;
  const collectModulo = (expression) => {
    if (expression.kind === "binary") {
      collectModulo(expression.left);
      collectModulo(expression.right);
      if (expression.op === "%") {
        moduloTemps.set(expression, [`tmp_mod_${moduloCount}_left`, `tmp_mod_${moduloCount}_right`]);
        moduloCount += 1;
      }
    } else if (expression.kind === "unary") {
      collectModulo(expression.expression);
    } else if (expression.kind === "call") {
      for (const argument of expression.args) collectModulo(argument);
    } else if (expression.kind === "index") {
      if (expression.constantIndex === undefined) collectModulo(expression.index);
    }
  };
  const collectExpressions = (statements) => {
    for (const statement of statements) {
      if (statement.kind === "let" || statement.kind === "assign" || statement.kind === "expr") {
        collectModulo(statement.expression);
      } else if (statement.kind === "arrayAssign") {
        collectModulo(statement.index);
        collectModulo(statement.expression);
      } else if (statement.kind === "return") {
        if (statement.expression) collectModulo(statement.expression);
      } else if (statement.kind === "if") {
        collectModulo(statement.condition);
        collectExpressions(statement.thenBlock.body);
        if (statement.elseBlock) collectExpressions(statement.elseBlock.body);
      } else if (statement.kind === "while") {
        collectModulo(statement.condition);
        collectExpressions(statement.body.body);
      } else if (statement.kind === "block") {
        collectExpressions(statement.body);
      }
    }
  };
  if (useF32) collectExpressions(fn.body);

  return {
    parameters,
    declarations,
    locals,
    moduloTemps,
  };
}

function numberLiteral(value) {
  if (Object.is(value, -0)) return "-0";
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "Infinity";
  if (value === -Infinity) return "-Infinity";
  return String(value);
}

function f32Literal(value) {
  if (!Number.isFinite(value) || Object.is(value, -0)) return numberLiteral(value);
  let shortest = numberLiteral(value);
  for (let precision = 1; precision <= 9; precision += 1) {
    const candidate = Number(value.toPrecision(precision)).toString();
    if (candidate.length < shortest.length && Object.is(Math.fround(Number(candidate)), value)) {
      shortest = candidate;
    }
  }
  return shortest;
}

function emitJavaScript(program, detailed, precision, svgMetadata) {
  const useF32 = precision === "f32";
  const functionsByName = program.functions;
  const svgTriCallSites = new Map((detailed.svgTriCallSites ?? []).map((site) => [
    `${site.function}:${site.line}:${site.column}`,
    site.id,
  ]));
  const globalsByName = new Map(program.globals.map((global, index) => [global.name, `g_${safeName(global.name)}_${index}`]));
  const reachableNames = detailed.functions;
  const reachableFunctions = reachableNames.map((name) => {
    const fn = functionsByName.get(name);
    if (!fn) backendError(`missing reachable function ${JSON.stringify(name)}`);
    return fn;
  });
  const functionNames = new Map(reachableNames.map((name, index) => [name, `fn_${safeName(name)}_${index}`]));
  const layouts = new Map(reachableFunctions.map((fn) => [fn.name, collectLayout(fn, useF32)]));

  const referencedArrays = new Set();
  const dynamicArrayNames = new Set();
  const visitArrayReferences = (expression) => {
    if (expression.kind === "index") {
      const arrayName = expression.arrayName ?? expression.name;
      referencedArrays.add(arrayName);
      if (expression.dynamic || expression.constantIndex === undefined) dynamicArrayNames.add(arrayName);
      visitArrayReferences(expression.index);
    } else if (expression.kind === "unary") {
      visitArrayReferences(expression.expression);
    } else if (expression.kind === "binary") {
      visitArrayReferences(expression.left);
      visitArrayReferences(expression.right);
    } else if (expression.kind === "call") {
      for (const argument of expression.args) visitArrayReferences(argument);
    }
  };
  const visitArrayStatements = (statements) => {
    for (const statement of statements) {
      switch (statement.kind) {
        case "let":
        case "assign":
        case "expr":
          visitArrayReferences(statement.expression);
          break;
        case "arrayAssign": {
          const arrayName = statement.arrayName ?? statement.name;
          referencedArrays.add(arrayName);
          if (statement.dynamic || statement.constantIndex === undefined) dynamicArrayNames.add(arrayName);
          visitArrayReferences(statement.index);
          visitArrayReferences(statement.expression);
          break;
        }
        case "return":
          if (statement.expression) visitArrayReferences(statement.expression);
          break;
        case "if":
          visitArrayReferences(statement.condition);
          visitArrayStatements(statement.thenBlock.body);
          if (statement.elseBlock) visitArrayStatements(statement.elseBlock.body);
          break;
        case "while":
          visitArrayReferences(statement.condition);
          visitArrayStatements(statement.body.body);
          break;
        case "block":
          visitArrayStatements(statement.body);
          break;
        default:
          break;
      }
    }
  };
  for (const fn of reachableFunctions) visitArrayStatements(fn.body);

  const detailedArrayLayout = new Map((detailed.arrayLayout ?? []).map((array) => [array.name, array]));
  const materializedArrays = program.arrays.filter((array) => {
    const layout = detailedArrayLayout.get(array.name);
    return array.mutable || referencedArrays.has(array.name) || layout?.materialized;
  });
  const arraysByName = new Map(materializedArrays.map((array, index) => [
    array.name,
    `a_${safeName(array.name)}_${index}`,
  ]));
  const dynamicArrayReferences = dynamicArrayNames.size > 0;

  const round = (expression) => useF32 ? `r(${expression})` : expression;
  const truth = (expression) => `t(${expression})`;

  const emitExpression = (expression, context) => {
    const emit = (node) => {
      switch (node.kind) {
        case "num":
          return round(numberLiteral(node.value));
        case "name": {
          const local = context.layout?.locals.get(node.name);
          if (local) return local;
          const global = globalsByName.get(node.name);
          if (global) return global;
          backendError(`unknown value ${JSON.stringify(node.name)}`, node);
          return "0";
        }
        case "index": {
          const arrayName = node.arrayName ?? node.name;
          const array = program.arrays.find((candidate) => candidate.name === arrayName);
          const target = arraysByName.get(arrayName);
          if (!array || !target) {
            backendError(`unknown array ${JSON.stringify(arrayName)}`, node);
          }
          const index = node.constantIndex !== undefined
            ? String(node.constantIndex)
            : `checkedArrayIndex(${emit(node.index)}, ${array.length}, ${JSON.stringify(arrayName)})`;
          // Float32Array loads are already exact f32 values in both profiles.
          return `${target}[${index}]`;
        }
        case "call": {
          if ((node.name === SVG_METADATA_BUILTIN || node.name === SVG_TRI_BUILTIN) && !svgMetadata) return round("0");
          const args = node.args.map((argument) => emit(argument)).join(", ");
          if (node.name === "tri" && svgMetadata) {
            const key = `${context.fn?.name ?? "<global>"}:${node.token?.line ?? 0}:${node.token?.column ?? 0}`;
            const callSiteId = svgTriCallSites.get(key);
            if (callSiteId === undefined) backendError("internal error: missing SVG triangle call-site identity", node);
            return `e.${SVG_TRI_BUILTIN}(${callSiteId}, ${args})`;
          }
          let call;
          if (Object.hasOwn(INTRINSICS, node.name)) {
            call = `${INTRINSICS[node.name].js}(${args})`;
          } else if (Object.hasOwn(MATH_IMPORTS, node.name)) {
            call = `Math.${node.name}(${args})`;
          } else if (BUILTIN_NAMES.has(node.name)) {
            call = `e.${node.name}(${args})`;
          } else {
            const target = functionNames.get(node.name);
            if (!target) backendError(`unknown function ${JSON.stringify(node.name)}`, node);
            call = `${target}(${args})`;
          }
          return round(call);
        }
        case "unary": {
          const value = emit(node.expression);
          if (node.op === "!") return `(${truth(value)} ? 0 : 1)`;
          if (node.op === "-") return round(`-(${value})`);
          if (node.op === "+") return round(`+(${value})`);
          backendError(`unsupported unary operator ${JSON.stringify(node.op)}`, node);
          return "0";
        }
        case "binary": {
          if (node.op === "&&") {
            const left = emit(node.left);
            const right = emit(node.right);
            return `(${truth(left)} ? (${truth(right)} ? 1 : 0) : 0)`;
          }
          if (node.op === "||") {
            const left = emit(node.left);
            const right = emit(node.right);
            return `(${truth(left)} ? 1 : (${truth(right)} ? 1 : 0))`;
          }
          if (node.op === "%") {
            const left = emit(node.left);
            const right = emit(node.right);
            if (!useF32) return `((${left}) % (${right}))`;
            const temps = context.layout?.moduloTemps.get(node);
            if (temps) {
              const [leftTemp, rightTemp] = temps;
              return `(${leftTemp} = (${left}), ${rightTemp} = (${right}), r(${leftTemp} - r(Math.trunc(r(${leftTemp} / ${rightTemp})) * ${rightTemp})))`;
            }
            // Global initializers are pure constant expressions, so repeating
            // their operands preserves value and avoids a module-level temp.
            return `r((${left}) - r(Math.trunc(r((${left}) / (${right}))) * (${right}))`;
          }

          const left = emit(node.left);
          const right = emit(node.right);
          const comparisons = new Set(["==", "!=", "<", ">", "<=", ">="]);
          if (comparisons.has(node.op)) {
            return `((${left}) ${node.op} (${right}) ? 1 : 0)`;
          }
          if (["+", "-", "*", "/"].includes(node.op)) {
            return round(`(${left}) ${node.op} (${right})`);
          }
          backendError(`unsupported binary operator ${JSON.stringify(node.op)}`, node);
          return "0";
        }
        default:
          backendError("unsupported expression node", node);
          return "0";
      }
    };
    return emit(expression);
  };

  const emitStatements = (statements, context, indent) => {
    const lines = [];
    const line = (text) => lines.push(`${indent}${text}`);
    const isStrippedSvgMetadata = (expression) => !svgMetadata
      && expression.kind === "call"
      && (expression.name === SVG_METADATA_BUILTIN || expression.name === SVG_TRI_BUILTIN);
    for (const statement of statements) {
      switch (statement.kind) {
        case "let": {
          const target = context.layout.locals.get(statement.name);
          line(`${target} = ${emitExpression(statement.expression, context)};`);
          break;
        }
        case "assign": {
          const local = context.layout.locals.get(statement.name);
          const global = globalsByName.get(statement.name);
          const target = local ?? global;
          if (!target) backendError(`unknown local or global ${JSON.stringify(statement.name)}`, statement);
          line(`${target} = ${emitExpression(statement.expression, context)};`);
          break;
        }
        case "arrayAssign": {
          const arrayName = statement.arrayName ?? statement.name;
          const array = program.arrays.find((candidate) => candidate.name === arrayName);
          const target = arraysByName.get(arrayName);
          if (!array || !target) {
            backendError(`unknown array ${JSON.stringify(arrayName)}`, statement);
          }
          const index = statement.constantIndex !== undefined
            ? String(statement.constantIndex)
            : `checkedArrayIndex(${emitExpression(statement.index, context)}, ${array.length}, ${JSON.stringify(arrayName)})`;
          // The computed property is evaluated before the RHS, so an invalid
          // dynamic index throws without running any value-side effects.
          line(`${target}[${index}] = ${emitExpression(statement.expression, context)};`);
          break;
        }
        case "expr":
          if (isStrippedSvgMetadata(statement.expression)) break;
          line(`${emitExpression(statement.expression, context)};`);
          break;
        case "return":
          line(`return ${statement.expression ? emitExpression(statement.expression, context) : round("0")};`);
          break;
        case "if": {
          line(`if (${truth(emitExpression(statement.condition, context))}) {`);
          lines.push(...emitStatements(statement.thenBlock.body, context, `${indent}  `));
          if (statement.elseBlock) {
            line("} else {");
            lines.push(...emitStatements(statement.elseBlock.body, context, `${indent}  `));
          }
          line("}");
          break;
        }
        case "while":
          line(`while (${truth(emitExpression(statement.condition, context))}) {`);
          lines.push(...emitStatements(statement.body.body, context, `${indent}  `));
          line("}");
          break;
        case "block":
          line("{");
          lines.push(...emitStatements(statement.body, context, `${indent}  `));
          line("}");
          break;
        case "empty":
          line(";");
          break;
        default:
          backendError("unsupported statement node", statement);
      }
    }
    return lines;
  };

  const lines = ["(e = {}) => {", `  // precision: ${precision}`, "  const t = (v) => v !== 0;"];
  if (useF32) lines.push("  const r = Math.fround;");
  if (dynamicArrayReferences) {
    lines.push(
      "  const checkedArrayIndex = (index, length, name) => {",
      "    if (!Number.isFinite(index) || !Number.isInteger(index) || index < 0 || index >= length) {",
      "      throw new RangeError(`array ${name} index is out of bounds for length ${length}`);",
      "    }",
      "    return index;",
      "  };",
    );
  }

  const globalContext = {
    layout: { locals: new Map(), moduloTemps: new Map() },
  };
  for (const global of program.globals) {
    lines.push(`  let ${globalsByName.get(global.name)} = ${emitExpression(global.expression, globalContext)};`);
  }
  for (const array of materializedArrays) {
    const target = arraysByName.get(array.name);
    const values = array.values ?? [];
    const isRepeat = array.repeatCount !== null && array.repeatCount !== undefined
      || Boolean(array.initializer?.repeat);
    if (isRepeat) {
      lines.push(`  const ${target} = new Float32Array(${array.length}).fill(${f32Literal(values[0] ?? 0)});`);
    } else {
      lines.push(`  const ${target} = new Float32Array([${values.map(f32Literal).join(", ")}]);`);
    }
  }

  for (const fn of reachableFunctions) {
    const layout = layouts.get(fn.name);
    const context = {fn, layout};
    lines.push(`  function ${functionNames.get(fn.name)}(${layout.parameters.join(", ")}) {`);
    if (useF32 && layout.parameters.length) {
      for (const parameter of layout.parameters) lines.push(`    ${parameter} = r(${parameter});`);
    }
    if (layout.declarations.length) {
      lines.push(`    let ${layout.declarations.map((name) => `${name} = 0`).join(", ")};`);
    }
    const moduloNames = [...layout.moduloTemps.values()].flat();
    if (moduloNames.length) {
      lines.push(`    let ${moduloNames.map((name) => `${name} = 0`).join(", ")};`);
    }
    lines.push(...emitStatements(fn.body, context, "    "));
    lines.push(`    return ${round("0")};`);
    lines.push("  }");
  }

  const init = functionNames.get("init");
  const frame = functionNames.get("frame");
  lines.push(`  return {init: ${init}, frame: ${frame}};`, "}");
  return lines.join("\n");
}

/**
 * Compile Slim source to a readable JavaScript factory for size comparisons.
 * The generated expression has no browser or renderer policy; callers provide
 * the small e.tri/e.sound/e.input host object when invoking the factory.
 */
export function compileJavaScript(source, options = {}) {
  const precision = options?.precision ?? "native";
  if (precision !== "native" && precision !== "f32") {
    throw new TypeError(`Slim JavaScript compile error: unsupported precision ${JSON.stringify(precision)}`);
  }
  const svgMetadata = options?.svgMetadata ?? false;
  if (typeof svgMetadata !== "boolean") {
    throw new TypeError(`Slim JavaScript compile error: svgMetadata must be true or false, got ${JSON.stringify(svgMetadata)}`);
  }
  const detailed = compileDetailed(source, {svgMetadata});
  const program = parseProgram(source);
  return {
    code: emitJavaScript(program, detailed, precision, svgMetadata),
    imports: detailed.imports.slice(),
    precision,
    svgMetadata,
  };
}

export default compileJavaScript;
