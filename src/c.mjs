import {compileDetailed as compileWasmDetailed, parseProgram, INTRINSICS, MATH_IMPORTS} from "./compiler.mjs";

const SVG_METADATA_BUILTIN = "svg_group";
const SVG_TRI_BUILTIN = "svg_tri";
const HOST_BUILTINS = new Set(["tri", "sound", "input", "text"]);
const MATH_HOSTS = new Set([...Object.keys(MATH_IMPORTS), ...Object.keys(INTRINSICS)]);

const HOST_SIGNATURES = Object.freeze({
  tri: ["float x0", "float y0", "float x1", "float y1", "float x2", "float y2", "float r", "float g", "float b"],
  sound: ["float kind", "float pitch", "float duration"],
  input: ["float index"],
  text: ["float id", "float x", "float y", "float size", "float tone"],
  sin: ["float value"],
  cos: ["float value"],
  atan2: ["float y", "float x"],
  pow: ["float base", "float exponent"],
  floor: ["float value"],
  ceil: ["float value"],
  trunc: ["float value"],
  sqrt: ["float value"],
  abs: ["float value"],
  min: ["float left", "float right"],
  max: ["float left", "float right"],
});

function cFloat(value) {
  const rounded = Math.fround(value);
  if (Number.isNaN(rounded)) return '__builtin_nanf("")';
  if (rounded === Infinity) return "__builtin_inff()";
  if (rounded === -Infinity) return "-__builtin_inff()";
  if (Object.is(rounded, -0)) return "-0.0f";
  let shortest = String(rounded);
  for (let precision = 1; precision <= 9; precision += 1) {
    const candidate = Number(rounded.toPrecision(precision)).toString();
    if (candidate.length < shortest.length && Object.is(Math.fround(Number(candidate)), rounded)) {
      shortest = candidate;
    }
  }
  if (!/[.eE]/.test(shortest)) shortest += ".0";
  return `${shortest}f`;
}

function cString(value) {
  const bytes = new TextEncoder().encode(value);
  let encoded = '"';
  for (const byte of bytes) {
    if (byte >= 0x20 && byte <= 0x7e && byte !== 0x22 && byte !== 0x5c) {
      encoded += String.fromCharCode(byte);
    } else {
      encoded += `\\${byte.toString(8).padStart(3, "0")}`;
    }
  }
  return `${encoded}"`;
}

function textComments(source) {
  const texts = [];
  for (const match of source.matchAll(/^[ \t]*\/\/[ \t]*text:[ \t]*(.*?)[ \t]*\r?$/gm)) {
    texts.push(match[1]);
  }
  return texts;
}

function visitExpression(expression, visitor) {
  visitor(expression);
  switch (expression.kind) {
    case "unary":
      visitExpression(expression.expression, visitor);
      break;
    case "binary":
      visitExpression(expression.left, visitor);
      visitExpression(expression.right, visitor);
      break;
    case "call":
      expression.args.forEach((argument) => visitExpression(argument, visitor));
      break;
    case "index":
      visitExpression(expression.index, visitor);
      break;
    default:
      break;
  }
}

function visitStatements(statements, visitor) {
  for (const statement of statements) {
    visitor(statement);
    switch (statement.kind) {
      case "let":
      case "assign":
      case "expr":
        visitExpression(statement.expression, visitor);
        break;
      case "arrayAssign":
        visitExpression(statement.index, visitor);
        visitExpression(statement.expression, visitor);
        break;
      case "return":
        if (statement.expression) visitExpression(statement.expression, visitor);
        break;
      case "if":
        visitExpression(statement.condition, visitor);
        visitStatements(statement.thenBlock.body, visitor);
        if (statement.elseBlock) visitStatements(statement.elseBlock.body, visitor);
        break;
      case "while":
        visitExpression(statement.condition, visitor);
        visitStatements(statement.body.body, visitor);
        break;
      case "block":
        visitStatements(statement.body, visitor);
        break;
      default:
        break;
    }
  }
}

function collectLocalNames(fn) {
  const names = fn.params.map((parameter) => parameter.name);
  const collect = (statements) => {
    for (const statement of statements) {
      if (statement.kind === "let") names.push(statement.name);
      else if (statement.kind === "block") collect(statement.body);
      else if (statement.kind === "if") {
        collect(statement.thenBlock.body);
        if (statement.elseBlock) collect(statement.elseBlock.body);
      } else if (statement.kind === "while") collect(statement.body.body);
    }
  };
  collect(fn.body);
  return names;
}

function evaluateConstant(expression) {
  switch (expression.kind) {
    case "num": return Math.fround(expression.value);
    case "unary": {
      const value = evaluateConstant(expression.expression);
      if (expression.op === "+") return value;
      if (expression.op === "-") return Math.fround(-value);
      if (expression.op === "!") return value === 0 ? 1 : 0;
      break;
    }
    case "binary": {
      const left = evaluateConstant(expression.left);
      const right = evaluateConstant(expression.right);
      switch (expression.op) {
        case "+": return Math.fround(left + right);
        case "-": return Math.fround(left - right);
        case "*": return Math.fround(left * right);
        case "/": return Math.fround(left / right);
        case "%": {
          const quotient = Math.fround(left / right);
          return Math.fround(left - Math.fround(Math.fround(Math.trunc(quotient)) * right));
        }
        case "==": return left === right ? 1 : 0;
        case "!=": return left !== right ? 1 : 0;
        case "<": return left < right ? 1 : 0;
        case "<=": return left <= right ? 1 : 0;
        case ">": return left > right ? 1 : 0;
        case ">=": return left >= right ? 1 : 0;
        case "&&": return left !== 0 && right !== 0 ? 1 : 0;
        case "||": return left !== 0 || right !== 0 ? 1 : 0;
        default: break;
      }
      break;
    }
    default:
      break;
  }
  throw new Error("internal error: nonconstant expression in C static initializer");
}

function emitC(program, wasm, source) {
  const functions = wasm.functions.map((name) => {
    const fn = program.functions.get(name);
    if (!fn) throw new Error(`internal error: missing reachable function ${JSON.stringify(name)}`);
    return fn;
  });
  const functionSymbols = new Map(functions.map((fn, index) => [
    fn.name,
    fn.name === "init" ? "slim_init" : fn.name === "frame" ? "slim_frame" : `slim_fn_${index}`,
  ]));
  const globalSymbols = new Map(program.globals.map((global, index) => [global.name, `slim_global_${index}`]));
  const arraySymbols = new Map(program.arrays.map((array, index) => [array.name, `slim_array_${index}`]));
  const globalValues = new Map(program.globals.map((global) => [global.name, evaluateConstant(global.expression)]));
  const hostImportSet = new Set(wasm.imports);

  for (const fn of functions) {
    visitStatements(fn.body, (node) => {
      if (node.kind === "binary" && node.op === "%") hostImportSet.add("trunc");
      if (node.kind === "call" && Object.hasOwn(INTRINSICS, node.name)) hostImportSet.add(node.name);
    });
  }

  // The source compiler deliberately strips SVG metadata calls unless enabled.
  // C uses the same default and does not add host calls for those annotations.
  hostImportSet.delete(SVG_METADATA_BUILTIN);
  hostImportSet.delete(SVG_TRI_BUILTIN);
  const imports = [
    ...wasm.imports.filter((name) => name !== SVG_METADATA_BUILTIN && name !== SVG_TRI_BUILTIN),
    ...Object.keys(INTRINSICS).filter((name) => hostImportSet.has(name) && !wasm.imports.includes(name)),
  ];
  const hasDynamicArray = functions.some((fn) => {
    let found = false;
    visitStatements(fn.body, (node) => {
      if ((node.kind === "index" && node.dynamic) || (node.kind === "arrayAssign" && node.dynamic)) found = true;
    });
    return found;
  });

  const lines = [
    "#ifndef SLIM_GAME_H",
    "#define SLIM_GAME_H",
    "#include <stdint.h>",
    "",
  ];
  for (const name of imports) {
    const signature = HOST_SIGNATURES[name];
    if (!signature) throw new Error(`internal error: no native host signature for ${JSON.stringify(name)}`);
    lines.push(`extern float slim_${name}(${signature.join(", ")});`);
  }
  if (hasDynamicArray) lines.push("extern void slim_trap(void);");

  const texts = textComments(source);
  const textEntries = texts.length === 0 ? ["(const char *)0"] : texts.map(cString);
  lines.push(
    "",
    `const char *const slim_texts[] = {${textEntries.join(", ")}};`,
    `const uint32_t slim_text_count = ${texts.length}u;`,
    "",
  );

  for (const global of program.globals) {
    const value = globalValues.get(global.name);
    lines.push(`static float ${globalSymbols.get(global.name)} = ${cFloat(value)};`);
  }
  for (const array of program.arrays) {
    const symbol = arraySymbols.get(array.name);
    const qualifier = array.mutable ? "static float" : "static const float";
    const values = array.values.length === 0 ? [0] : array.values;
    lines.push(`${qualifier} ${symbol}[${Math.max(1, array.length)}] = {${values.map(cFloat).join(", ")}};`);
  }
  if (program.globals.length || program.arrays.length) lines.push("");

  if (hasDynamicArray) {
    lines.push(
      "static uint32_t slim_checked_index(float index, uint32_t length) {",
      "  if (!(index >= 0.0f && index < (float)length && index == (float)(uint32_t)index)) {",
      "    slim_trap();",
      "    return 0u;",
      "  }",
      "  return (uint32_t)index;",
      "}",
      "",
    );
  }

  for (const fn of functions) {
    const symbol = functionSymbols.get(fn.name);
    const params = fn.params.map((_, index) => `float p_${index}`).join(", ");
    lines.push(`float ${symbol}(${params || "void"});`);
  }
  lines.push("float slim_init(void);");
  lines.push("float slim_frame(void);");
  lines.push("");

  for (const fn of functions) {
    const symbol = functionSymbols.get(fn.name);
    const names = collectLocalNames(fn);
    const localSymbols = new Map(names.map((name, index) => [name, `slim_local_${index}`]));
    const context = {
      fn,
      localSymbols,
      tempCount: 0,
      newTemp() {
        const name = `slim_tmp_${this.tempCount}`;
        this.tempCount += 1;
        return name;
      },
    };
    const params = fn.params.map((parameter, index) => `float p_${index}`).join(", ") || "void";
    const parameterSetup = fn.params.map((parameter, index) => `  ${localSymbols.get(parameter.name)} = p_${index};`);
    const body = emitStatements(fn.body, context, 1, {
      functionSymbols,
      globalSymbols,
      arraySymbols,
      program,
    });
    const localDeclarations = names.length
      ? [`  float ${names.map((_, index) => `slim_local_${index}`).join(", ")};`]
      : [];
    const tempDeclarations = context.tempCount
      ? [`  float ${Array.from({length: context.tempCount}, (_, index) => `slim_tmp_${index}`).join(", ")};`]
      : [];
    lines.push(`float ${symbol}(${params}) {`);
    lines.push(...localDeclarations, ...tempDeclarations, ...parameterSetup, ...body);
    lines.push("  return 0.0f;", "}", "");
  }

  lines.push("#endif /* SLIM_GAME_H */");
  return {
    code: lines.join("\n"),
    imports,
    hostImports: [...imports.map((name) => `slim_${name}`), ...(hasDynamicArray ? ["slim_trap"] : [])],
    functions: wasm.functions.slice(),
    globals: wasm.globals.map((global) => global.name),
    arrays: wasm.arrayLayout.map(({name, length, mutable}) => ({name, length, mutable})),
    texts,
    textCount: texts.length,
  };
}

function emitExpression(node, context, symbols) {
  const result = (lines, value) => ({lines, value});
  const temp = () => context.newTemp();
  switch (node.kind) {
    case "num":
      return result([], cFloat(node.value));
    case "name": {
      const local = context.localSymbols.get(node.name);
      if (local) return result([], local);
      const global = symbols.globalSymbols.get(node.name);
      if (global) return result([], global);
      throw new SyntaxError(`Slim C compile error at ${node.token?.line ?? 1}:${node.token?.column ?? 1}: unknown value ${JSON.stringify(node.name)}`);
    }
    case "index": {
      const arrayName = node.arrayName ?? node.name;
      const symbol = symbols.arraySymbols.get(arrayName);
      const array = symbols.program.arrays.find((candidate) => candidate.name === arrayName);
      if (!symbol || !array) {
        throw new SyntaxError(`Slim C compile error at ${node.token?.line ?? 1}:${node.token?.column ?? 1}: unknown array ${JSON.stringify(arrayName)}`);
      }
      if (node.constantIndex !== undefined) return result([], `${symbol}[${node.constantIndex}u]`);
      const index = emitExpression(node.index, context, symbols);
      const checked = temp();
      const loaded = temp();
      return result([
        ...index.lines,
        `  ${checked} = (float)slim_checked_index(${index.value}, ${array.length}u);`,
        `  ${loaded} = ${symbol}[(uint32_t)${checked}];`,
      ], loaded);
    }
    case "call": {
      if (node.name === SVG_METADATA_BUILTIN || node.name === SVG_TRI_BUILTIN) return result([], "0.0f");
      const lines = [];
      const args = [];
      for (const argument of node.args) {
        const emitted = emitExpression(argument, context, symbols);
        lines.push(...emitted.lines);
        const staged = temp();
        lines.push(`  ${staged} = ${emitted.value};`);
        args.push(staged);
      }
      let callee = symbols.functionSymbols.get(node.name);
      if (callee === undefined && (HOST_BUILTINS.has(node.name) || MATH_HOSTS.has(node.name))) callee = `slim_${node.name}`;
      if (callee === undefined) {
        throw new SyntaxError(`Slim C compile error at ${node.token?.line ?? 1}:${node.token?.column ?? 1}: unknown function ${JSON.stringify(node.name)}`);
      }
      const output = temp();
      lines.push(`  ${output} = ${callee}(${args.join(", ")});`);
      return result(lines, output);
    }
    case "unary": {
      const operand = emitExpression(node.expression, context, symbols);
      const output = temp();
      let expression;
      if (node.op === "-") expression = `-(${operand.value})`;
      else if (node.op === "+") expression = `+(${operand.value})`;
      else if (node.op === "!") expression = `((${operand.value}) == 0.0f ? 1.0f : 0.0f)`;
      else throw new SyntaxError(`Slim C compile error at ${node.token?.line ?? 1}:${node.token?.column ?? 1}: unsupported unary operator ${JSON.stringify(node.op)}`);
      return result([...operand.lines, `  ${output} = ${expression};`], output);
    }
    case "binary": {
      const left = emitExpression(node.left, context, symbols);
      const leftValue = temp();
      const lines = [...left.lines, `  ${leftValue} = ${left.value};`];
      const output = temp();
      if (node.op === "&&" || node.op === "||") {
        const right = emitExpression(node.right, context, symbols);
        if (node.op === "&&") {
          lines.push(`  if (${leftValue} != 0.0f) {`, ...right.lines.map((line) => `  ${line}`));
          lines.push(`    ${output} = (${right.value} != 0.0f) ? 1.0f : 0.0f;`, "  } else {");
          lines.push(`    ${output} = 0.0f;`, "  }");
        } else {
          lines.push(`  if (${leftValue} != 0.0f) {`, `    ${output} = 1.0f;`, "  } else {");
          lines.push(...right.lines.map((line) => `  ${line}`));
          lines.push(`    ${output} = (${right.value} != 0.0f) ? 1.0f : 0.0f;`, "  }");
        }
        return result(lines, output);
      }
      const right = emitExpression(node.right, context, symbols);
      const rightValue = temp();
      lines.push(...right.lines, `  ${rightValue} = ${right.value};`);
      let expression;
      if (node.op === "%") {
        const quotient = temp();
        const truncated = temp();
        const product = temp();
        lines.push(
          `  ${quotient} = ${leftValue} / ${rightValue};`,
          `  ${truncated} = slim_trunc(${quotient});`,
          `  ${product} = ${truncated} * ${rightValue};`,
          `  ${output} = ${leftValue} - ${product};`,
        );
        return result(lines, output);
      }
      if (["==", "!=", "<", "<=", ">", ">="].includes(node.op)) {
        expression = `((${leftValue}) ${node.op} (${rightValue}) ? 1.0f : 0.0f)`;
      } else if (["+", "-", "*", "/"].includes(node.op)) {
        expression = `(${leftValue}) ${node.op} (${rightValue})`;
      } else {
        throw new SyntaxError(`Slim C compile error at ${node.token?.line ?? 1}:${node.token?.column ?? 1}: unsupported binary operator ${JSON.stringify(node.op)}`);
      }
      lines.push(`  ${output} = ${expression};`);
      return result(lines, output);
    }
    default:
      throw new SyntaxError(`Slim C compile error at ${node.token?.line ?? 1}:${node.token?.column ?? 1}: unsupported expression node`);
  }
}

function emitStatements(statements, context, depth, symbols) {
  const lines = [];
  const indent = "  ".repeat(depth);
  for (const statement of statements) {
    switch (statement.kind) {
      case "let": {
        const value = emitExpression(statement.expression, context, symbols);
        lines.push(...value.lines, `${indent}${context.localSymbols.get(statement.name)} = ${value.value};`);
        break;
      }
      case "assign": {
        const target = context.localSymbols.get(statement.name) ?? symbols.globalSymbols.get(statement.name);
        if (!target) throw new SyntaxError(`Slim C compile error at ${statement.token?.line ?? 1}:${statement.token?.column ?? 1}: unknown local or global ${JSON.stringify(statement.name)}`);
        const value = emitExpression(statement.expression, context, symbols);
        lines.push(...value.lines, `${indent}${target} = ${value.value};`);
        break;
      }
      case "arrayAssign": {
        const arrayName = statement.arrayName ?? statement.name;
        const array = symbols.program.arrays.find((candidate) => candidate.name === arrayName);
        const target = symbols.arraySymbols.get(arrayName);
        if (!array || !target) throw new SyntaxError(`Slim C compile error at ${statement.token?.line ?? 1}:${statement.token?.column ?? 1}: unknown array ${JSON.stringify(arrayName)}`);
        let indexValue;
        if (statement.constantIndex !== undefined) {
          indexValue = `${statement.constantIndex}u`;
        } else {
          const index = emitExpression(statement.index, context, symbols);
          const checked = context.newTemp();
          lines.push(...index.lines);
          lines.push(`${indent}${checked} = (float)slim_checked_index(${index.value}, ${array.length}u);`);
          indexValue = `(uint32_t)${checked}`;
        }
        const value = emitExpression(statement.expression, context, symbols);
        lines.push(...value.lines, `${indent}${target}[${indexValue}] = ${value.value};`);
        break;
      }
      case "expr": {
        const expression = statement.expression;
        if (expression.kind === "call" && (expression.name === SVG_METADATA_BUILTIN || expression.name === SVG_TRI_BUILTIN)) break;
        const value = emitExpression(expression, context, symbols);
        lines.push(...value.lines);
        break;
      }
      case "return": {
        if (!statement.expression) {
          lines.push(`${indent}return 0.0f;`);
        } else {
          const value = emitExpression(statement.expression, context, symbols);
          lines.push(...value.lines, `${indent}return ${value.value};`);
        }
        break;
      }
      case "if": {
        const condition = emitExpression(statement.condition, context, symbols);
        const conditionTemp = context.newTemp();
        lines.push(...condition.lines, `${indent}${conditionTemp} = ${condition.value};`, `${indent}if (${conditionTemp} != 0.0f) {`);
        lines.push(...emitStatements(statement.thenBlock.body, context, depth + 1, symbols));
        if (statement.elseBlock) {
          lines.push(`${indent}} else {`, ...emitStatements(statement.elseBlock.body, context, depth + 1, symbols));
        }
        lines.push(`${indent}}`);
        break;
      }
      case "while": {
        lines.push(`${indent}for (;;) {`);
        const condition = emitExpression(statement.condition, context, symbols);
        const conditionTemp = context.newTemp();
        lines.push(...condition.lines.map((line) => `${indent}${line}`));
        lines.push(`${indent}  ${conditionTemp} = ${condition.value};`, `${indent}  if (${conditionTemp} == 0.0f) break;`);
        lines.push(...emitStatements(statement.body.body, context, depth + 1, symbols));
        lines.push(`${indent}}`);
        break;
      }
      case "block":
        lines.push(`${indent}{`, ...emitStatements(statement.body, context, depth + 1, symbols), `${indent}}`);
        break;
      case "empty":
        lines.push(`${indent};`);
        break;
      default:
        throw new SyntaxError(`Slim C compile error at ${statement.token?.line ?? 1}:${statement.token?.column ?? 1}: unsupported statement node`);
    }
  }
  return lines;
}

/** Compile Slim source to a header-only C backend. */
export function compileCDetailed(source) {
  if (typeof source !== "string") {
    throw new TypeError("Slim C compile error: source must be a string");
  }
  const wasm = compileWasmDetailed(source);
  const program = parseProgram(source);
  return emitC(program, wasm, source);
}

/** Compile Slim source to standalone C header text. */
export function compileC(source) {
  return compileCDetailed(source).code;
}

export default compileC;
