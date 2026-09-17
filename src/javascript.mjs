import {compileDetailed, parseProgram} from "./compiler.mjs";

const BUILTIN_NAMES = new Set(["tri", "sound", "input"]);

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
    }
  };
  const collectExpressions = (statements) => {
    for (const statement of statements) {
      if (statement.kind === "let" || statement.kind === "assign" || statement.kind === "expr") {
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

function emitJavaScript(program, detailed, precision) {
  const useF32 = precision === "f32";
  const functionsByName = program.functions;
  const globalsByName = new Map(program.globals.map((global, index) => [global.name, `g_${safeName(global.name)}_${index}`]));
  const reachableNames = detailed.functions;
  const reachableFunctions = reachableNames.map((name) => {
    const fn = functionsByName.get(name);
    if (!fn) backendError(`missing reachable function ${JSON.stringify(name)}`);
    return fn;
  });
  const functionNames = new Map(reachableNames.map((name, index) => [name, `fn_${safeName(name)}_${index}`]));
  const layouts = new Map(reachableFunctions.map((fn) => [fn.name, collectLayout(fn, useF32)]));

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
        case "call": {
          const args = node.args.map((argument) => emit(argument)).join(", ");
          let call;
          if (BUILTIN_NAMES.has(node.name)) {
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
        case "expr":
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

  const globalContext = {
    layout: { locals: new Map(), moduloTemps: new Map() },
  };
  for (const global of program.globals) {
    lines.push(`  let ${globalsByName.get(global.name)} = ${emitExpression(global.expression, globalContext)};`);
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
  const detailed = compileDetailed(source);
  const program = parseProgram(source);
  return {
    code: emitJavaScript(program, detailed, precision),
    imports: detailed.imports.slice(),
    precision,
  };
}

export default compileJavaScript;
