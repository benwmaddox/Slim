/*
 * Slim v0 compiler
 *
 * This is deliberately a small, freestanding compiler.  The compiler itself
 * runs on Node, while the result is a plain WebAssembly module with no runtime
 * dependencies.  Values at the language boundary are f32; predicates are
 * represented as f32 0/1 values so game code can use them in arithmetic too.
 */

const SVG_METADATA_BUILTIN = "svg_group";
const SVG_TRI_BUILTIN = "svg_tri";
// Math functions WebAssembly has no instruction for. WASM modules import them
// from the host (which passes JavaScript's Math function through); the
// JavaScript backend calls Math directly.
export const MATH_IMPORTS = Object.freeze({
  sin: Object.freeze({ params: 1, result: true }),
  cos: Object.freeze({ params: 1, result: true }),
  atan2: Object.freeze({ params: 2, result: true }),
  pow: Object.freeze({ params: 2, result: true }),
});
const BUILTIN_ORDER = ["tri", "sound", "input", SVG_METADATA_BUILTIN, SVG_TRI_BUILTIN, ...Object.keys(MATH_IMPORTS)];

const BUILTINS = Object.freeze({
  tri: Object.freeze({ params: 9, result: true }),
  sound: Object.freeze({ params: 3, result: true }),
  input: Object.freeze({ params: 1, result: true }),
  [SVG_METADATA_BUILTIN]: Object.freeze({ params: 1, result: true }),
  [SVG_TRI_BUILTIN]: Object.freeze({ params: 10, result: true }),
  ...MATH_IMPORTS,
});

// Pure numeric builtins that compile to a single WebAssembly f32 instruction
// (and to the matching Math function in JavaScript); they need no host import.
// `round` is deliberately absent: Math.round rounds halves up while
// f32.nearest rounds them to even, so the two backends would disagree.
export const INTRINSICS = Object.freeze({
  floor: Object.freeze({ params: 1, opcode: 0x8e, js: "Math.floor" }),
  ceil: Object.freeze({ params: 1, opcode: 0x8d, js: "Math.ceil" }),
  trunc: Object.freeze({ params: 1, opcode: 0x8f, js: "Math.trunc" }),
  sqrt: Object.freeze({ params: 1, opcode: 0x91, js: "Math.sqrt" }),
  abs: Object.freeze({ params: 1, opcode: 0x8b, js: "Math.abs" }),
  min: Object.freeze({ params: 2, opcode: 0x96, js: "Math.min" }),
  max: Object.freeze({ params: 2, opcode: 0x97, js: "Math.max" }),
});

const isReservedName = (name) => Object.hasOwn(BUILTINS, name) || Object.hasOwn(INTRINSICS, name);

const F32 = 0x7d;
const TRIANGLE_PACK_ENCODING = "triangles-i8-palette-f32";
const PACKED_TRIANGLE_UNSUPPORTED = "SLIM_PACKING_UNSUPPORTED";

function compileError(message, token, code) {
  const line = token?.line ?? 1;
  const column = token?.column ?? 1;
  const error = new SyntaxError(`Slim compile error at ${line}:${column}: ${message}`);
  if (code !== undefined) error.code = code;
  throw error;
}

function isIdentifierStart(ch) {
  return !!ch && /[A-Za-z_]/.test(ch);
}

function isIdentifierPart(ch) {
  return !!ch && /[A-Za-z0-9_]/.test(ch);
}

class Lexer {
  constructor(source) {
    this.source = source;
    this.offset = 0;
    this.line = 1;
    this.column = 1;
    this.tokens = [];
  }

  advance() {
    const ch = this.source[this.offset++];
    if (ch === "\n") {
      this.line += 1;
      this.column = 1;
    } else {
      this.column += 1;
    }
    return ch;
  }

  token(kind, value, line, column) {
    return { kind, value, line, column };
  }

  lex() {
    while (this.offset < this.source.length) {
      const ch = this.source[this.offset];

      if (ch === "\uFEFF" || /\s/.test(ch)) {
        this.advance();
        continue;
      }

      if (ch === "/" && this.source[this.offset + 1] === "/") {
        this.advance();
        this.advance();
        while (this.offset < this.source.length && this.source[this.offset] !== "\n") {
          this.advance();
        }
        continue;
      }

      if (ch === "/" && this.source[this.offset + 1] === "*") {
        const line = this.line;
        const column = this.column;
        this.advance();
        this.advance();
        let closed = false;
        while (this.offset < this.source.length) {
          if (this.source[this.offset] === "*" && this.source[this.offset + 1] === "/") {
            this.advance();
            this.advance();
            closed = true;
            break;
          }
          this.advance();
        }
        if (!closed) {
          compileError("unterminated block comment", { line, column });
        }
        continue;
      }

      const line = this.line;
      const column = this.column;

      if (isIdentifierStart(ch)) {
        let value = this.advance();
        while (isIdentifierPart(this.source[this.offset])) {
          value += this.advance();
        }
        this.tokens.push(this.token("id", value, line, column));
        continue;
      }

      if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(this.source[this.offset + 1] ?? ""))) {
        let raw = "";
        if (ch === ".") {
          raw += this.advance();
          while (/[0-9]/.test(this.source[this.offset] ?? "")) {
            raw += this.advance();
          }
        } else {
          while (/[0-9]/.test(this.source[this.offset] ?? "")) {
            raw += this.advance();
          }
          if (this.source[this.offset] === ".") {
            raw += this.advance();
            while (/[0-9]/.test(this.source[this.offset] ?? "")) {
              raw += this.advance();
            }
          }
        }
        if (this.source[this.offset] === "e" || this.source[this.offset] === "E") {
          raw += this.advance();
          if (this.source[this.offset] === "+" || this.source[this.offset] === "-") {
            raw += this.advance();
          }
          const exponentStart = this.offset;
          while (/[0-9]/.test(this.source[this.offset] ?? "")) {
            raw += this.advance();
          }
          if (this.offset === exponentStart) {
            compileError("invalid number exponent", { line, column });
          }
        }
        const value = Number(raw);
        if (!Number.isFinite(value)) {
          compileError(`number is outside the supported range: ${raw}`, { line, column });
        }
        this.tokens.push(this.token("num", value, line, column));
        continue;
      }

      const two = this.source.slice(this.offset, this.offset + 2);
      if (["==", "!=", "<=", ">=", "&&", "||"].includes(two)) {
        this.advance();
        this.advance();
        this.tokens.push(this.token("op", two, line, column));
        continue;
      }

      if ("{}[](),;=+-*/%<>!".includes(ch)) {
        this.advance();
        this.tokens.push(this.token("op", ch, line, column));
        continue;
      }

      compileError(`unexpected character ${JSON.stringify(ch)}`, { line, column });
    }

    this.tokens.push(this.token("eof", "", this.line, this.column));
    return this.tokens;
  }
}

const BINARY_PRECEDENCE = Object.freeze({
  "||": 1,
  "&&": 2,
  "==": 3,
  "!=": 3,
  "<": 4,
  "<=": 4,
  ">": 4,
  ">=": 4,
  "+": 5,
  "-": 5,
  "*": 6,
  "/": 6,
  "%": 6,
});

class Parser {
  constructor(source) {
    this.tokens = new Lexer(source).lex();
    this.index = 0;
  }

  peek(distance = 0) {
    return this.tokens[Math.min(this.index + distance, this.tokens.length - 1)];
  }

  at(value) {
    return this.peek().value === value;
  }

  consume() {
    return this.tokens[this.index++];
  }

  expect(value) {
    const token = this.peek();
    if (token.value !== value) {
      compileError(`expected ${JSON.stringify(value)}, found ${token.kind === "eof" ? "end of input" : JSON.stringify(token.value)}`, token);
    }
    return this.consume();
  }

  expectIdentifier(what = "identifier") {
    const token = this.peek();
    if (token.kind !== "id") {
      compileError(`expected ${what}, found ${token.kind === "eof" ? "end of input" : JSON.stringify(token.value)}`, token);
    }
    return this.consume();
  }

  parse() {
    const globals = [];
    const arrays = [];
    const globalNames = new Set();
    const arrayNames = new Set();
    const constants = [];
    const constantNames = new Set();
    const functions = new Map();

    while (this.peek().kind !== "eof") {
      const token = this.peek();
      if (token.kind !== "id") {
        compileError(`expected top-level const, global, or fn, found ${JSON.stringify(token.value)}`, token);
      }
      if (token.value === "const") {
        const constant = this.parseConstant();
        if (constantNames.has(constant.name)) {
          const duplicateKind = constant.kind === "array" && arrayNames.has(constant.name) ? "array" : "constant";
          compileError(`duplicate ${duplicateKind} ${JSON.stringify(constant.name)}`, constant.token);
        }
        constantNames.add(constant.name);
        if (constant.kind === "array") {
          if (arrayNames.has(constant.name)) {
            compileError(`duplicate array ${JSON.stringify(constant.name)}`, constant.token);
          }
          arrayNames.add(constant.name);
          arrays.push(constant);
        } else constants.push(constant);
      } else if (token.value === "global") {
        const global = this.parseGlobal();
        if (globalNames.has(global.name)) {
          compileError(`duplicate global ${JSON.stringify(global.name)}`, global.token);
        }
        globalNames.add(global.name);
        if (global.kind === "array") {
          if (arrayNames.has(global.name)) {
            compileError(`duplicate array ${JSON.stringify(global.name)}`, global.token);
          }
          arrayNames.add(global.name);
          arrays.push(global);
        } else globals.push(global);
      } else if (token.value === "fn") {
        const fn = this.parseFunction();
        if (functions.has(fn.name)) {
          compileError(`duplicate function ${JSON.stringify(fn.name)}`, fn.token);
        }
        if (isReservedName(fn.name)) {
          compileError(`function name ${JSON.stringify(fn.name)} is reserved for a builtin`, fn.token);
        }
        functions.set(fn.name, fn);
      } else {
        compileError(`expected top-level const, global, or fn, found ${JSON.stringify(token.value)}`, token);
      }
    }

    const program = {globals, arrays, functions};
    const outerNames = new Set([...globalNames, ...constants.map((constant) => constant.name)]);
    for (const fn of functions.values()) scopeLocals(fn, outerNames);
    const lowered = constants.length === 0 ? program : lowerConstants(program, constants);
    return resolveArrays(lowered);
  }

  parseConstant() {
    const token = this.expect("const");
    const name = this.expectIdentifier("constant name");
    this.expect("=");
    const expression = this.at("[") ? this.parseArrayInitializer() : this.parseExpression();
    this.expect(";");
    return expression.kind === "arrayInitializer"
      ? {kind: "array", name: name.value, mutable: false, initializer: expression, token}
      : {kind: "constant", name: name.value, expression, token};
  }

  parseGlobal() {
    const token = this.expect("global");
    const name = this.expectIdentifier("global name");
    this.expect("=");
    const expression = this.at("[") ? this.parseArrayInitializer() : this.parseExpression();
    this.expect(";");
    return expression.kind === "arrayInitializer"
      ? {kind: "array", name: name.value, mutable: true, initializer: expression, token}
      : {kind: "global", name: name.value, expression, token};
  }

  parseArrayInitializer() {
    const token = this.expect("[");
    const elements = [];
    let value = null;
    let repeat = null;
    if (!this.at("]")) {
      const first = this.parseExpression();
      if (this.at(";")) {
        this.consume();
        value = first;
        repeat = this.parseExpression();
      } else {
        elements.push(first);
        while (this.at(",")) {
          this.consume();
          if (this.at("]")) break;
          elements.push(this.parseExpression());
        }
      }
    }
    this.expect("]");
    return {kind: "arrayInitializer", elements, value, repeat, token};
  }

  parseFunction() {
    const token = this.expect("fn");
    const name = this.expectIdentifier("function name");
    this.expect("(");
    const params = [];
    if (!this.at(")")) {
      while (true) {
        params.push(this.expectIdentifier("parameter name"));
        if (!this.at(",")) break;
        this.consume();
      }
    }
    this.expect(")");
    const body = this.parseBlock();
    if (this.at(";")) this.consume();
    return {
      kind: "function",
      name: name.value,
      params: params.map((parameter) => ({ name: parameter.value, token: parameter })),
      body: body.body,
      token,
    };
  }

  parseBlock() {
    this.expect("{");
    const body = [];
    while (!this.at("}")) {
      if (this.peek().kind === "eof") {
        compileError("unterminated block", this.peek());
      }
      body.push(this.parseStatement());
    }
    this.expect("}");
    return { kind: "block", body };
  }

  parseStatement() {
    const token = this.peek();

    if (token.value === "let") {
      this.consume();
      const name = this.expectIdentifier("local name");
      this.expect("=");
      const expression = this.parseExpression();
      this.expect(";");
      return { kind: "let", name: name.value, expression, token: name };
    }

    if (token.value === "if") {
      this.consume();
      this.expect("(");
      const condition = this.parseExpression();
      this.expect(")");
      const thenBlock = this.parseBlock();
      let elseBlock = null;
      if (this.at("else")) {
        this.consume();
        if (this.at("if")) {
          elseBlock = { kind: "block", body: [this.parseStatement()] };
        } else {
          elseBlock = this.parseBlock();
        }
      }
      return { kind: "if", condition, thenBlock, elseBlock, token };
    }

    if (token.value === "while") {
      this.consume();
      this.expect("(");
      const condition = this.parseExpression();
      this.expect(")");
      const body = this.parseBlock();
      return { kind: "while", condition, body, token };
    }

    if (token.value === "return") {
      this.consume();
      const expression = this.at(";") ? null : this.parseExpression();
      this.expect(";");
      return { kind: "return", expression, token };
    }

    if (token.value === "{") {
      return this.parseBlock();
    }

    if (token.kind === "id" && this.peek(1).value === "=") {
      const name = this.consume();
      this.consume();
      const expression = this.parseExpression();
      this.expect(";");
      return { kind: "assign", name: name.value, expression, token: name };
    }

    if (token.kind === "id" && this.peek(1).value === "[") {
      const name = this.consume();
      this.consume();
      const index = this.parseExpression();
      this.expect("]");
      this.expect("=");
      const expression = this.parseExpression();
      this.expect(";");
      return {kind: "arrayAssign", name: name.value, index, expression, token: name};
    }

    if (this.at(";")) {
      this.consume();
      return { kind: "empty", token };
    }

    const expression = this.parseExpression();
    this.expect(";");
    return { kind: "expr", expression, token };
  }

  parseExpression() {
    return this.parseBinary(1);
  }

  parseBinary(minPrecedence) {
    let left = this.parseUnary();
    while (true) {
      const token = this.peek();
      const precedence = BINARY_PRECEDENCE[token.value];
      if (precedence === undefined || precedence < minPrecedence) break;
      this.consume();
      const right = this.parseBinary(precedence + 1);
      left = { kind: "binary", op: token.value, left, right, token };
    }
    return left;
  }

  parseUnary() {
    const token = this.peek();
    if (token.value === "!" || token.value === "-" || token.value === "+") {
      this.consume();
      return { kind: "unary", op: token.value, expression: this.parseUnary(), token };
    }
    return this.parsePrimary();
  }

  parsePrimary() {
    const token = this.peek();
    if (token.kind === "num") {
      this.consume();
      return { kind: "num", value: token.value, token };
    }
    if (token.kind === "id") {
      this.consume();
      if (!this.at("(")) {
        if (this.at("[")) {
          this.consume();
          const index = this.parseExpression();
          this.expect("]");
          return {kind: "index", name: token.value, index, token};
        }
        return { kind: "name", name: token.value, token };
      }
      this.consume();
      const args = [];
      if (!this.at(")")) {
        while (true) {
          args.push(this.parseExpression());
          if (!this.at(",")) break;
          this.consume();
        }
      }
      this.expect(")");
      return { kind: "call", name: token.value, args, token };
    }
    if (token.value === "(") {
      this.consume();
      const expression = this.parseExpression();
      this.expect(")");
      return expression;
    }
    compileError(`expected expression, found ${token.kind === "eof" ? "end of input" : JSON.stringify(token.value)}`, token);
  }
}

function evalConstant(expression, resolveName, errorMessage = "global initializers must be constant numeric expressions") {
  switch (expression.kind) {
    case "num":
      return Math.fround(expression.value);
    case "name":
      if (resolveName) return resolveName(expression.name, expression.token);
      break;
    case "unary": {
      const value = evalConstant(expression.expression, resolveName, errorMessage);
      if (expression.op === "+") return value;
      if (expression.op === "-") return Math.fround(-value);
      if (expression.op === "!") return value === 0 ? 1 : 0;
      break;
    }
    case "binary": {
      const left = evalConstant(expression.left, resolveName, errorMessage);
      const right = evalConstant(expression.right, resolveName, errorMessage);
      switch (expression.op) {
        case "+": return Math.fround(left + right);
        case "-": return Math.fround(left - right);
        case "*": return Math.fround(left * right);
        case "/": return Math.fround(left / right);
        case "%": {
          const quotient = Math.fround(left / right);
          const truncated = Math.fround(Math.trunc(quotient));
          return Math.fround(Math.fround(left - Math.fround(truncated * right)));
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
  compileError(errorMessage, expression.token);
}

function collectFunctionLocalNames(fn) {
  const names = new Set(fn.params.map((parameter) => parameter.name));
  const collectStatements = (statements) => {
    for (const statement of statements) {
      if (statement.kind === "let") {
        names.add(statement.name);
      } else if (statement.kind === "block") {
        collectStatements(statement.body);
      } else if (statement.kind === "if") {
        collectStatements(statement.thenBlock.body);
        if (statement.elseBlock) collectStatements(statement.elseBlock.body);
      } else if (statement.kind === "while") {
        collectStatements(statement.body.body);
      }
    }
  };
  collectStatements(fn.body);
  return names;
}

// Locals are block scoped: a name may be declared again in a sibling block, and
// a use before its declaration refers to the outer name (a global or constant).
// Redeclaring a name that is already visible (a parameter or an enclosing local)
// is still an error.  This pass gives every declaration a unique function-wide
// name (`name`, then `name$1`, ...) and rewrites its uses, so the layout and
// code generation of both backends keep treating locals as one flat set.
// `$` cannot appear in source identifiers, so generated names never collide.
function scopeLocals(fn, outerNames) {
  const used = new Set();
  const scopes = [new Map()];
  const lookup = (name) => {
    for (let index = scopes.length - 1; index >= 0; index -= 1) {
      if (scopes[index].has(name)) return scopes[index].get(name);
    }
    return undefined;
  };
  const declare = (node) => {
    if (lookup(node.name) !== undefined) {
      compileError(`duplicate local ${JSON.stringify(node.name)}`, node.token);
    }
    let unique = node.name;
    // Locals named like a global or constant always get a fresh name, so that
    // name stays visible outside the block (or before the let) that shadows it.
    for (let count = 1; used.has(unique) || (unique === node.name && outerNames.has(unique)); count += 1) {
      unique = `${node.name}$${count}`;
    }
    used.add(unique);
    scopes[scopes.length - 1].set(node.name, unique);
    node.name = unique;
  };
  for (const parameter of fn.params) declare(parameter);

  const rewriteExpression = (expression) => {
    switch (expression.kind) {
      case "name": {
        const unique = lookup(expression.name);
        if (unique !== undefined) expression.name = unique;
        break;
      }
      case "unary":
        rewriteExpression(expression.expression);
        break;
      case "binary":
        rewriteExpression(expression.left);
        rewriteExpression(expression.right);
        break;
      case "call":
        expression.args.forEach(rewriteExpression);
        break;
      case "index":
        rewriteExpression(expression.index);
        break;
      default:
        break;
    }
  };
  const rewriteBlock = (statements) => {
    scopes.push(new Map());
    statements.forEach(rewriteStatement);
    scopes.pop();
  };
  function rewriteStatement(statement) {
    switch (statement.kind) {
      case "let":
        rewriteExpression(statement.expression);
        declare(statement);
        break;
      case "assign": {
        rewriteExpression(statement.expression);
        const unique = lookup(statement.name);
        if (unique !== undefined) statement.name = unique;
        break;
      }
      case "arrayAssign":
        rewriteExpression(statement.index);
        rewriteExpression(statement.expression);
        break;
      case "expr":
        rewriteExpression(statement.expression);
        break;
      case "return":
        if (statement.expression) rewriteExpression(statement.expression);
        break;
      case "if":
        rewriteExpression(statement.condition);
        rewriteBlock(statement.thenBlock.body);
        if (statement.elseBlock) rewriteBlock(statement.elseBlock.body);
        break;
      case "while":
        rewriteExpression(statement.condition);
        rewriteBlock(statement.body.body);
        break;
      case "block":
        rewriteBlock(statement.body);
        break;
      default:
        break;
    }
  }
  fn.body.forEach(rewriteStatement);
}

function lowerConstants(program, declarations) {
  const constants = new Map(declarations.map((constant) => [constant.name, constant]));
  const globalNames = new Set(program.globals.map((global) => global.name));
  const arrayNames = new Set(program.arrays.map((array) => array.name));
  const functionNames = new Set(program.functions.keys());

  for (const constant of declarations) {
    if (globalNames.has(constant.name)) {
      compileError(`constant name ${JSON.stringify(constant.name)} collides with a global`, constant.token);
    }
    if (arrayNames.has(constant.name)) {
      compileError(`constant name ${JSON.stringify(constant.name)} collides with an array`, constant.token);
    }
    if (functionNames.has(constant.name)) {
      compileError(`constant name ${JSON.stringify(constant.name)} collides with a function`, constant.token);
    }
    if (isReservedName(constant.name)) {
      compileError(`constant name ${JSON.stringify(constant.name)} is reserved for a builtin`, constant.token);
    }
  }

  const states = new Map();
  const values = new Map();
  const evaluate = (name, referenceToken) => {
    const state = states.get(name);
    if (state === 1) {
      compileError(`cyclic constant reference involving ${JSON.stringify(name)}`, referenceToken);
    }
    if (state === 2) return values.get(name);

    const declaration = constants.get(name);
    if (!declaration) {
      compileError("constant initializers must be constant numeric expressions", referenceToken);
    }

    states.set(name, 1);
    const value = evalConstant(
      declaration.expression,
      (referenceName, token) => {
        if (!constants.has(referenceName)) {
          compileError("constant initializers must be constant numeric expressions", token);
        }
        return evaluate(referenceName, token);
      },
      "constant initializers must be constant numeric expressions",
    );
    states.set(name, 2);
    values.set(name, value);
    return value;
  };

  for (const declaration of declarations) evaluate(declaration.name, declaration.token);

  const lowerExpression = (expression, shadowed) => {
    switch (expression.kind) {
      case "name":
        if (!shadowed.has(expression.name) && constants.has(expression.name)) {
          return {kind: "num", value: values.get(expression.name), token: expression.token};
        }
        return expression;
      case "unary":
        expression.expression = lowerExpression(expression.expression, shadowed);
        return expression;
      case "binary":
        expression.left = lowerExpression(expression.left, shadowed);
        expression.right = lowerExpression(expression.right, shadowed);
        return expression;
      case "call":
        expression.args = expression.args.map((argument) => lowerExpression(argument, shadowed));
        return expression;
      case "index":
        expression.index = lowerExpression(expression.index, shadowed);
        return expression;
      default:
        return expression;
    }
  };

  for (const global of program.globals) {
    global.expression = lowerExpression(global.expression, new Set());
  }
  for (const array of program.arrays) {
    if (array.initializer.value) array.initializer.value = lowerExpression(array.initializer.value, new Set());
    array.initializer.elements = array.initializer.elements.map((element) => lowerExpression(element, new Set()));
    if (array.initializer.repeat) array.initializer.repeat = lowerExpression(array.initializer.repeat, new Set());
  }

  const lowerStatements = (statements, shadowed) => {
    for (const statement of statements) {
      switch (statement.kind) {
        case "let":
          statement.expression = lowerExpression(statement.expression, shadowed);
          break;
        case "assign":
          if (!shadowed.has(statement.name) && constants.has(statement.name)) {
            compileError(`cannot assign to constant ${JSON.stringify(statement.name)}`, statement.token);
          }
          statement.expression = lowerExpression(statement.expression, shadowed);
          break;
        case "arrayAssign":
          statement.index = lowerExpression(statement.index, shadowed);
          statement.expression = lowerExpression(statement.expression, shadowed);
          break;
        case "expr":
          statement.expression = lowerExpression(statement.expression, shadowed);
          break;
        case "return":
          if (statement.expression) {
            statement.expression = lowerExpression(statement.expression, shadowed);
          }
          break;
        case "if":
          statement.condition = lowerExpression(statement.condition, shadowed);
          lowerStatements(statement.thenBlock.body, shadowed);
          if (statement.elseBlock) lowerStatements(statement.elseBlock.body, shadowed);
          break;
        case "while":
          statement.condition = lowerExpression(statement.condition, shadowed);
          lowerStatements(statement.body.body, shadowed);
          break;
        case "block":
          lowerStatements(statement.body, shadowed);
          break;
        default:
          break;
      }
    }
  };

  for (const fn of program.functions.values()) {
    lowerStatements(fn.body, collectFunctionLocalNames(fn));
  }

  return program;
}

const MAX_ARRAY_ELEMENTS = 65536;

function tryEvalConstant(expression) {
  if (!expression) return undefined;
  if (expression.kind === "name" || expression.kind === "call" || expression.kind === "index") return undefined;
  if (expression.kind === "unary") {
    if (tryEvalConstant(expression.expression) === undefined) return undefined;
  } else if (expression.kind === "binary") {
    if (tryEvalConstant(expression.left) === undefined || tryEvalConstant(expression.right) === undefined) return undefined;
  } else if (expression.kind !== "num") {
    return undefined;
  }
  return evalConstant(expression);
}

function validateArrayLength(array, value, total) {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    compileError("array repeat length must be a finite nonnegative integer", array.initializer.repeat?.token ?? array.token);
  }
  if (total + value > MAX_ARRAY_ELEMENTS) {
    compileError(`fixed array element limit is ${MAX_ARRAY_ELEMENTS}`, array.token);
  }
  return value;
}

function validateArrayIndex(array, value, token = array.token) {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0 || value >= array.length) {
    compileError(`array ${JSON.stringify(array.name)} index is out of bounds for length ${array.length}`, token);
  }
  // Preserve the language's useful -0 behavior while keeping metadata and
  // direct memory offsets deterministic.
  return value === 0 ? 0 : value;
}

function resolveArrays(program) {
  const arrays = new Map(program.arrays.map((array) => [array.name, array]));
  const globalNames = new Set(program.globals.map((global) => global.name));
  const functionNames = new Set(program.functions.keys());

  let totalArrayElements = 0;
  for (const array of program.arrays) {
    if (globalNames.has(array.name)) {
      compileError(`array name ${JSON.stringify(array.name)} collides with a global`, array.token);
    }
    if (functionNames.has(array.name)) {
      compileError(`array name ${JSON.stringify(array.name)} collides with a function`, array.token);
    }
    if (isReservedName(array.name)) {
      compileError(`array name ${JSON.stringify(array.name)} is reserved for a builtin`, array.token);
    }

    const initializer = array.initializer;
    let values;
    if (initializer.repeat) {
      const count = validateArrayLength(array, evalConstant(
        initializer.repeat,
        undefined,
        "array repeat length must be a finite nonnegative integer",
      ), totalArrayElements);
      const value = evalConstant(
        initializer.value,
        undefined,
        "array initializers must be constant numeric expressions",
      );
      values = Array.from({length: count}, () => value);
      array.repeatCount = count;
    } else {
      values = initializer.elements.map((element) => evalConstant(
        element,
        undefined,
        "array initializers must be constant numeric expressions",
      ));
      if (totalArrayElements + values.length > MAX_ARRAY_ELEMENTS) {
        compileError(`fixed array element limit is ${MAX_ARRAY_ELEMENTS}`, array.token);
      }
      array.repeatCount = null;
    }
    array.values = values;
    array.length = values.length;
    array.byteLength = values.length * 4;
    totalArrayElements += values.length;
  }

  const lowerArrayExpression = (expression, shadowed) => {
    switch (expression.kind) {
      case "name":
        if (!shadowed.has(expression.name) && arrays.has(expression.name)) {
          compileError(`array ${JSON.stringify(expression.name)} requires an index`, expression.token);
        }
        return expression;
      case "unary":
        expression.expression = lowerArrayExpression(expression.expression, shadowed);
        return expression;
      case "binary":
        expression.left = lowerArrayExpression(expression.left, shadowed);
        expression.right = lowerArrayExpression(expression.right, shadowed);
        return expression;
      case "call":
        expression.args = expression.args.map((argument) => lowerArrayExpression(argument, shadowed));
        return expression;
      case "index": {
        expression.index = lowerArrayExpression(expression.index, shadowed);
        if (shadowed.has(expression.name)) {
          compileError(`cannot index shadowed scalar ${JSON.stringify(expression.name)}`, expression.token);
        }
        const array = arrays.get(expression.name);
        if (!array) {
          if (globalNames.has(expression.name)) {
            compileError(`cannot index scalar ${JSON.stringify(expression.name)}`, expression.token);
          }
          compileError(`unknown array ${JSON.stringify(expression.name)}`, expression.token);
        }
        expression.arrayName = array.name;
        const known = tryEvalConstant(expression.index);
        if (known !== undefined) {
          expression.indexToken = expression.index.token;
          expression.constantIndex = validateArrayIndex(array, known, expression.index.token);
          if (!array.mutable) {
            return {kind: "num", value: array.values[expression.constantIndex], token: expression.token};
          }
        } else {
          expression.dynamic = true;
        }
        return expression;
      }
      default:
        return expression;
    }
  };

  for (const global of program.globals) {
    global.expression = lowerArrayExpression(global.expression, new Set());
  }

  const lowerStatements = (statements, shadowed) => {
    for (const statement of statements) {
      switch (statement.kind) {
        case "let":
          statement.expression = lowerArrayExpression(statement.expression, shadowed);
          break;
        case "assign":
          if (!shadowed.has(statement.name) && arrays.has(statement.name)) {
            compileError(`cannot assign to array ${JSON.stringify(statement.name)}`, statement.token);
          }
          statement.expression = lowerArrayExpression(statement.expression, shadowed);
          break;
        case "arrayAssign": {
          statement.index = lowerArrayExpression(statement.index, shadowed);
          statement.expression = lowerArrayExpression(statement.expression, shadowed);
          if (shadowed.has(statement.name)) {
            compileError(`cannot index shadowed scalar ${JSON.stringify(statement.name)}`, statement.token);
          }
          const array = arrays.get(statement.name);
          if (!array) {
            if (globalNames.has(statement.name)) {
              compileError(`cannot index scalar ${JSON.stringify(statement.name)}`, statement.token);
            }
            compileError(`unknown array ${JSON.stringify(statement.name)}`, statement.token);
          }
          if (!array.mutable) {
            compileError(`cannot assign to constant array ${JSON.stringify(statement.name)}`, statement.token);
          }
          statement.arrayName = array.name;
          const known = tryEvalConstant(statement.index);
          if (known !== undefined) {
            statement.indexToken = statement.index.token;
            statement.constantIndex = validateArrayIndex(array, known, statement.index.token);
          } else {
            statement.dynamic = true;
          }
          break;
        }
        case "expr":
          statement.expression = lowerArrayExpression(statement.expression, shadowed);
          break;
        case "return":
          if (statement.expression) statement.expression = lowerArrayExpression(statement.expression, shadowed);
          break;
        case "if":
          statement.condition = lowerArrayExpression(statement.condition, shadowed);
          lowerStatements(statement.thenBlock.body, shadowed);
          if (statement.elseBlock) lowerStatements(statement.elseBlock.body, shadowed);
          break;
        case "while":
          statement.condition = lowerArrayExpression(statement.condition, shadowed);
          lowerStatements(statement.body.body, shadowed);
          break;
        case "block":
          lowerStatements(statement.body, shadowed);
          break;
        default:
          break;
      }
    }
  };

  for (const fn of program.functions.values()) {
    lowerStatements(fn.body, collectFunctionLocalNames(fn));
  }

  program.arrays = program.arrays.map((array) => ({
    ...array,
    values: array.values.slice(),
  }));
  return program;
}

function walkExpression(expression, visitor) {
  visitor(expression);
  if (expression.kind === "unary") {
    walkExpression(expression.expression, visitor);
  } else if (expression.kind === "binary") {
    walkExpression(expression.left, visitor);
    walkExpression(expression.right, visitor);
  } else if (expression.kind === "call") {
    for (const argument of expression.args) walkExpression(argument, visitor);
  } else if (expression.kind === "index") {
    walkExpression(expression.index, visitor);
  }
}

function walkStatement(statement, visitor) {
  visitor(statement);
  switch (statement.kind) {
    case "let":
    case "assign":
    case "expr":
      walkExpression(statement.expression, visitor);
      break;
    case "arrayAssign":
      walkExpression(statement.index, visitor);
      walkExpression(statement.expression, visitor);
      break;
    case "return":
      if (statement.expression) walkExpression(statement.expression, visitor);
      break;
    case "if":
      walkExpression(statement.condition, visitor);
      walkStatement(statement.thenBlock, visitor);
      if (statement.elseBlock) walkStatement(statement.elseBlock, visitor);
      break;
    case "while":
      walkExpression(statement.condition, visitor);
      walkStatement(statement.body, visitor);
      break;
    case "block":
      for (const child of statement.body) walkStatement(child, visitor);
      break;
    default:
      break;
  }
}

function collectSvgTriCallSites(program) {
  const ids = new Map();
  const descriptors = [];
  let nextId = 1;
  for (const fn of program.functions.values()) {
    for (const statement of fn.body) {
      walkStatement(statement, (node) => {
        if (node.kind !== "call" || node.name !== "tri" || ids.has(node)) return;
        const id = nextId;
        nextId += 1;
        ids.set(node, id);
        descriptors.push({
          id,
          function: fn.name,
          line: node.token?.line ?? 0,
          column: node.token?.column ?? 0,
        });
      });
    }
  }
  return {ids, descriptors};
}

function prepareReachability(program, options = {}) {
  const svgMetadata = options.svgMetadata === true;
  const functions = new Map(program.functions);
  for (const root of ["init", "frame"]) {
    if (!functions.has(root)) {
      compileError(`missing required exported function ${JSON.stringify(root)}`);
    }
    const fn = functions.get(root);
    if (fn.params.length !== 0) {
      compileError(`exported function ${JSON.stringify(root)} must have zero parameters`, fn.token);
    }
  }

  const reachable = [];
  const seen = new Set();
  const builtinNames = new Set();

  const visit = (name) => {
    if (seen.has(name)) return;
    const fn = functions.get(name);
    if (!fn) {
      compileError(`unknown function ${JSON.stringify(name)}`);
    }
    seen.add(name);
    reachable.push(fn);
    for (const statement of fn.body) {
      walkStatement(statement, (node) => {
        if (node.kind !== "call") return;
        if (Object.hasOwn(INTRINSICS, node.name)) {
          const intrinsic = INTRINSICS[node.name];
          if (node.args.length !== intrinsic.params) {
            compileError(`builtin ${JSON.stringify(node.name)} expects ${intrinsic.params} arguments, got ${node.args.length}`, node.token);
          }
          return;
        }
        const builtin = Object.hasOwn(BUILTINS, node.name) ? BUILTINS[node.name] : undefined;
        if (builtin) {
          if (node.args.length !== builtin.params) {
            compileError(`builtin ${JSON.stringify(node.name)} expects ${builtin.params} arguments, got ${node.args.length}`, node.token);
          }
          if ((node.name === SVG_METADATA_BUILTIN || node.name === SVG_TRI_BUILTIN) && !svgMetadata) return;
          if (node.name === "tri" && svgMetadata) {
            builtinNames.add(SVG_TRI_BUILTIN);
          } else {
            builtinNames.add(node.name);
          }
          return;
        }
        const target = functions.get(node.name);
        if (!target) {
          compileError(`unknown function ${JSON.stringify(node.name)}`, node.token);
        }
        if (target.params.length !== node.args.length) {
          compileError(`function ${JSON.stringify(node.name)} expects ${target.params.length} arguments, got ${node.args.length}`, node.token);
        }
        visit(node.name);
      });
    }
  };

  visit("init");
  visit("frame");
  return {
    functions,
    reachable,
    importedBuiltins: BUILTIN_ORDER.filter((name) => builtinNames.has(name)),
  };
}

function collectFunctionLayout(fn, globalNames) {
  const locals = new Map();
  for (let index = 0; index < fn.params.length; index += 1) {
    const parameter = fn.params[index];
    if (locals.has(parameter.name)) {
      compileError(`duplicate local ${JSON.stringify(parameter.name)}`, parameter.token);
    }
    locals.set(parameter.name, index);
  }

  const declarations = [];
  const collectStatements = (statements) => {
    for (const statement of statements) {
      if (statement.kind === "let") {
        if (locals.has(statement.name)) {
          compileError(`duplicate local ${JSON.stringify(statement.name)}`, statement.token);
        }
        locals.set(statement.name, fn.params.length + declarations.length);
        declarations.push(statement.name);
      } else if (statement.kind === "block") {
        collectStatements(statement.body);
      } else if (statement.kind === "if") {
        collectStatements(statement.thenBlock.body);
        if (statement.elseBlock) collectStatements(statement.elseBlock.body);
      } else if (statement.kind === "while") {
        collectStatements(statement.body.body);
      }
    }
  };
  collectStatements(fn.body);

  const modTemps = new Map();
  const arrayTemps = new Map();
  let modCount = 0;
  const collectExpression = (expression) => {
    if (expression.kind === "binary") {
      collectExpression(expression.left);
      collectExpression(expression.right);
      if (expression.op === "%") {
        modTemps.set(expression, fn.params.length + declarations.length + modCount * 2);
        modCount += 1;
      }
    } else if (expression.kind === "unary") {
      collectExpression(expression.expression);
    } else if (expression.kind === "call") {
      for (const argument of expression.args) collectExpression(argument);
    } else if (expression.kind === "index") {
      collectExpression(expression.index);
      if (expression.dynamic) arrayTemps.set(expression, 0);
    }
  };
  const collectStatementExpressions = (statements) => {
    for (const statement of statements) {
      if (statement.kind === "let" || statement.kind === "assign" || statement.kind === "expr") {
        collectExpression(statement.expression);
      } else if (statement.kind === "arrayAssign") {
        collectExpression(statement.index);
        collectExpression(statement.expression);
        if (statement.dynamic) arrayTemps.set(statement, 0);
      } else if (statement.kind === "return") {
        if (statement.expression) collectExpression(statement.expression);
      } else if (statement.kind === "if") {
        collectExpression(statement.condition);
        collectStatementExpressions(statement.thenBlock.body);
        if (statement.elseBlock) collectStatementExpressions(statement.elseBlock.body);
      } else if (statement.kind === "while") {
        collectExpression(statement.condition);
        collectStatementExpressions(statement.body.body);
      } else if (statement.kind === "block") {
        collectStatementExpressions(statement.body);
      }
    }
  };
  collectStatementExpressions(fn.body);

  const arrayTempBase = fn.params.length + declarations.length + modCount * 2;
  let arrayTempCount = 0;
  for (const expression of arrayTemps.keys()) {
    arrayTemps.set(expression, arrayTempBase + arrayTempCount);
    arrayTempCount += 1;
  }

  // Keep this argument as part of the layout helper so the resolver stays the
  // single place where source names are checked.  Globals are mutable and
  // are valid expression names.
  void globalNames;
  return {
    locals,
    localCount: declarations.length + fn.params.length + modCount * 2 + arrayTempCount,
    modTemps,
    arrayTemps,
  };
}

function u32(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`internal error: invalid unsigned LEB128 value ${value}`);
  }
  const bytes = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
    if (remaining !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0);
  return bytes;
}

// Signed LEB128 is required for i32.const immediates.  In particular, the
// one-byte encoding 0x40 means -64 when decoded as a signed value, so using
// u32() for a memory address at that boundary silently points at the wrong
// slot.
function s32(value) {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
    throw new Error(`internal error: invalid signed LEB128 value ${value}`);
  }
  const bytes = [];
  let remaining = value;
  let done = false;
  while (!done) {
    let byte = remaining % 128;
    if (byte < 0) byte += 128;
    remaining = (remaining - byte) / 128;
    const signBit = byte & 0x40;
    done = (remaining === 0 && signBit === 0) || (remaining === -1 && signBit !== 0);
    if (!done) byte |= 0x80;
    bytes.push(byte);
  }
  return bytes;
}

function stringBytes(value) {
  const bytes = Array.from(new TextEncoder().encode(value));
  return [...u32(bytes.length), ...bytes];
}

function f32Bytes(value) {
  const buffer = new ArrayBuffer(4);
  new DataView(buffer).setFloat32(0, value, true);
  return Array.from(new Uint8Array(buffer));
}

function f32Bits(value) {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  view.setFloat32(0, value, true);
  return view.getUint32(0, true);
}

// Compact array storage is a physical representation detail.  The Slim
// frontend continues to expose f32 values, so only immutable arrays whose
// already-rounded values are exact, negative-zero-free integers can use it.
function chooseIntegerArrayEncoding(array, integerArrayStorage, packing) {
  if (integerArrayStorage !== "compact" || array.mutable || packing) return "f32";

  const values = array.values;
  if (!values.every((value) => (
    Number.isFinite(value) && Number.isInteger(value) && !Object.is(value, -0)
  ))) {
    return "f32";
  }

  if (values.every((value) => value >= 0)) {
    if (values.every((value) => value <= 0xff)) return "u8";
    if (values.every((value) => value <= 0xffff)) return "u16";
    return "f32";
  }
  if (values.every((value) => value >= -0x80 && value <= 0x7f)) return "i8";
  if (values.every((value) => value >= -0x8000 && value <= 0x7fff)) return "i16";
  return "f32";
}

function integerArrayElementBytes(encoding) {
  return encoding === "i8" || encoding === "u8" ? 1 : 2;
}

function integerArrayDataBytes(values, encoding) {
  const bytes = [];
  const elementBytes = integerArrayElementBytes(encoding);
  for (const value of values) {
    bytes.push(value & 0xff);
    if (elementBytes === 2) bytes.push((value >>> 8) & 0xff);
  }
  return bytes;
}

function integerArrayLoad(encoding) {
  switch (encoding) {
    case "i8": return {opcode: 0x2c, conversion: 0xb2, alignment: 0x00};
    case "u8": return {opcode: 0x2d, conversion: 0xb3, alignment: 0x00};
    case "i16": return {opcode: 0x2e, conversion: 0xb2, alignment: 0x01};
    case "u16": return {opcode: 0x2f, conversion: 0xb3, alignment: 0x01};
    default: throw new Error(`internal error: unsupported integer array encoding ${JSON.stringify(encoding)}`);
  }
}

function preparePackedTriangleArray(array) {
  if (array.mutable) {
    compileError(`packed triangle array ${JSON.stringify(array.name)} must be an immutable const array`, array.token, PACKED_TRIANGLE_UNSUPPORTED);
  }
  if (array.length % 9 !== 0) {
    compileError(`packed triangle array ${JSON.stringify(array.name)} length must be a multiple of 9`, array.token, PACKED_TRIANGLE_UNSUPPORTED);
  }

  const dataBytes = [];
  const paletteValues = [];
  const paletteIndices = new Map();
  for (let triangle = 0; triangle < array.length / 9; triangle += 1) {
    const base = triangle * 9;
    for (let lane = 0; lane < 6; lane += 1) {
      const value = array.values[base + lane];
      if (!Number.isFinite(value) || !Number.isInteger(value) || value < -128 || value > 127) {
        compileError(
          `packed triangle array ${JSON.stringify(array.name)} coordinate ${base + lane} must be a finite integer in [-128, 127]`,
          array.token,
          PACKED_TRIANGLE_UNSUPPORTED,
        );
      }
      if (Object.is(value, -0)) {
        compileError(
          `packed triangle array ${JSON.stringify(array.name)} coordinate ${base + lane} cannot be negative zero`,
          array.token,
          PACKED_TRIANGLE_UNSUPPORTED,
        );
      }
      dataBytes.push(value & 0xff);
    }

    const color = array.values.slice(base + 6, base + 9);
    const key = color.map((value) => f32Bits(value)).join(":");
    let paletteIndex = paletteIndices.get(key);
    if (paletteIndex === undefined) {
      paletteIndex = paletteValues.length / 3;
      if (paletteIndex >= 256) {
        compileError(`packed triangle array ${JSON.stringify(array.name)} palette exceeds 256 colors`, array.token, PACKED_TRIANGLE_UNSUPPORTED);
      }
      paletteIndices.set(key, paletteIndex);
      paletteValues.push(...color);
    }
    dataBytes.push(paletteIndex);
  }

  const paletteBytes = paletteValues.flatMap((value) => f32Bytes(value));
  return {
    encoding: TRIANGLE_PACK_ENCODING,
    dataBytes,
    paletteBytes,
    triangleCount: array.length / 9,
    paletteSize: paletteValues.length / 3,
    byteLength: dataBytes.length + paletteBytes.length,
  };
}

function section(id, payload) {
  return [id, ...u32(payload.length), ...payload];
}

function typeKey(params) {
  return `${params}=>1`;
}

function emitModule(program, options = {}) {
  const globalStorage = options.globalStorage ?? "globals";
  const packedTriangleNames = options.packedTriangleArrays ?? [];
  const integerArrayStorage = options.integerArrayStorage ?? "f32";
  const svgMetadata = options.svgMetadata === true;
  const svgTriCallSites = svgMetadata ? collectSvgTriCallSites(program) : {ids: new Map(), descriptors: []};
  const globals = program.globals.map((global) => ({
    name: global.name,
    value: evalConstant(global.expression),
  }));
  const globalIndices = new Map(globals.map((global, index) => [global.name, index]));
  const globalNames = new Set(globalIndices.keys());
  const globalLayout = globals.map((global, index) => ({name: global.name, offset: index * 4}));
  const globalOffsets = new Map(globalLayout.map((global) => [global.name, global.offset]));

  const reachability = prepareReachability(program, {svgMetadata});
  const importedNames = reachability.importedBuiltins;

  const arrayByName = new Map(program.arrays.map((array) => [array.name, array]));
  const packedTriangles = new Map();
  for (const name of packedTriangleNames) {
    const array = arrayByName.get(name);
    if (!array) {
      compileError(`packed triangle target ${JSON.stringify(name)} is not a declared array`);
    }
    packedTriangles.set(name, preparePackedTriangleArray(array));
  }
  const totalArrayElements = program.arrays.reduce((total, array) => total + array.length, 0);
  const dynamicArrayNames = new Set();
  for (const fn of reachability.reachable) {
    for (const statement of fn.body) {
      walkStatement(statement, (node) => {
        if ((node.kind === "index" || node.kind === "arrayAssign") && node.dynamic) {
          dynamicArrayNames.add(node.arrayName ?? node.name);
        }
      });
    }
  }
  const arrayStorage = program.arrays.map((array) => {
    const packing = packedTriangles.get(array.name) ?? null;
    const encoding = packing
      ? packing.encoding
      : chooseIntegerArrayEncoding(array, integerArrayStorage, packing);
    const elementBytes = packing ? null : encoding === "f32" ? 4 : integerArrayElementBytes(encoding);
    const physicalByteLength = packing?.byteLength ?? array.length * elementBytes;
    return {
      declaration: array,
      packing,
      encoding,
      elementBytes,
      physicalByteLength,
      materialized: array.mutable || dynamicArrayNames.has(array.name),
      offset: null,
    };
  });
  const arrayStorageByName = new Map(arrayStorage.map((item) => [item.declaration.name, item]));
  const scalarMemoryBytes = globalStorage === "memory" ? globals.length * 4 : 0;
  let nextArrayOffset = scalarMemoryBytes;
  for (const item of arrayStorage) {
    if (!item.materialized) continue;
    item.offset = nextArrayOffset;
    nextArrayOffset += item.physicalByteLength;
  }
  const allocatedBytes = Math.max(scalarMemoryBytes, nextArrayOffset);

  const types = [];
  const typeIndices = new Map();
  const ensureType = (params) => {
    const key = typeKey(params);
    let index = typeIndices.get(key);
    if (index !== undefined) return index;
    index = types.length;
    typeIndices.set(key, index);
    types.push(params);
    return index;
  };

  const importTypeIndices = new Map();
  for (const name of importedNames) {
    importTypeIndices.set(name, ensureType(BUILTINS[name].params));
  }
  const functionTypeIndices = new Map();
  for (const fn of reachability.reachable) {
    functionTypeIndices.set(fn.name, ensureType(fn.params.length));
  }

  const importCount = importedNames.length;
  const functionIndices = new Map();
  for (let index = 0; index < reachability.reachable.length; index += 1) {
    functionIndices.set(reachability.reachable[index].name, importCount + index);
  }

  // Packed arrays are immutable, so only arrays with a reachable dynamic read
  // need a decoder function.  Keeping the decoder out of the source
  // reachability list preserves the public function metadata and static-fold
  // behavior for all other arrays.
  const packedDecoderNames = [...packedTriangles.keys()].filter((name) => dynamicArrayNames.has(name));
  const packedDecoderTypeIndex = packedDecoderNames.length > 0 ? ensureType(1) : undefined;
  const packedDecoderIndices = new Map(packedDecoderNames.map((name, index) => [
    name,
    importCount + reachability.reachable.length + index,
  ]));

  const layouts = new Map();
  for (const fn of reachability.reachable) {
    layouts.set(fn.name, collectFunctionLayout(fn, globalNames));
  }

  const imports = [];
  for (const name of importedNames) {
    imports.push(...stringBytes("e"), ...stringBytes(name), 0x00, ...u32(importTypeIndices.get(name)));
  }

  const functionSection = [];
  for (const fn of reachability.reachable) {
    functionSection.push(...u32(functionTypeIndices.get(fn.name)));
  }
  for (const name of packedDecoderNames) {
    functionSection.push(...u32(packedDecoderTypeIndex));
  }

  const globalsSection = [];
  if (globalStorage === "globals") {
    for (const global of globals) {
      // v0 globals are mutable so the game can keep compact state in the module
      // without introducing a heap or a separate state ABI.
      globalsSection.push(F32, 0x01, 0x43, ...f32Bytes(global.value), 0x0b);
    }
  }

  // Keep the address itself on the stack for the common small-offset case.
  // For larger offsets, an i32.const 0 plus a memarg offset can be shorter.
  // Keep the natural f32 alignment when an absolute address is aligned.  A
  // packed byte array can leave the next f32 array or scalar at an unaligned
  // address; alignment is only a hint, but emitting zero there accurately
  // describes the access and works on every WASM engine.
  const memoryAccess = (opcode, offset, alignment = offset % 4 === 0 ? 0x02 : 0x00) => {
    const direct = [0x41, ...s32(offset), opcode, alignment, 0x00];
    const memarg = [0x41, 0x00, opcode, alignment, ...u32(offset)];
    return direct.length <= memarg.length ? direct : memarg;
  };

  const memoryStore = (offset, value) => {
    const alignment = offset % 4 === 0 ? 0x02 : 0x00;
    const direct = [0x41, ...s32(offset), ...value, 0x38, alignment, 0x00];
    const memarg = [0x41, 0x00, ...value, 0x38, alignment, ...u32(offset)];
    return direct.length <= memarg.length ? direct : memarg;
  };

  const contextFor = (fn) => ({
    fn,
    layout: layouts.get(fn.name),
    globalIndices,
    arrays: arrayByName,
    arrayStorage: arrayStorageByName,
    functionIndices,
    packedDecoderIndices,
    importedNames,
    svgTriCallSites: svgTriCallSites.ids,
  });

  const emitExpr = (expression, context) => {
    const code = [];
    const append = (...bytes) => code.push(...bytes);
    const emit = (node) => {
      switch (node.kind) {
        case "num":
          append(0x43, ...f32Bytes(node.value));
          return;
        case "name": {
          const localIndex = context.layout.locals.get(node.name);
          if (localIndex !== undefined) {
            append(0x20, ...u32(localIndex));
            return;
          }
          if (context.arrays.has(node.name)) {
            compileError(`array ${JSON.stringify(node.name)} requires an index`, node.token);
          }
          const globalIndex = context.globalIndices.get(node.name);
          if (globalIndex !== undefined) {
            if (globalStorage === "globals") {
              append(0x23, ...u32(globalIndex));
            } else {
              append(...memoryAccess(0x2a, globalOffsets.get(node.name)));
            }
            return;
          }
          compileError(`unknown value ${JSON.stringify(node.name)}`, node.token);
          return;
        }
        case "index":
          append(...emitArrayRead(node, context));
          return;
        case "call": {
          if ((node.name === SVG_METADATA_BUILTIN || node.name === SVG_TRI_BUILTIN) && !svgMetadata) {
            append(0x43, ...f32Bytes(0));
            return;
          }
          if (node.name === "tri" && svgMetadata) {
            const callSiteId = context.svgTriCallSites.get(node);
            if (callSiteId === undefined) {
              compileError("internal error: missing SVG triangle call-site identity", node.token);
            }
            append(0x43, ...f32Bytes(callSiteId));
            for (const argument of node.args) emit(argument);
            const svgTriIndex = context.importedNames.indexOf(SVG_TRI_BUILTIN);
            if (svgTriIndex < 0) {
              compileError("internal error: missing SVG triangle metadata import", node.token);
            }
            append(0x10, ...u32(svgTriIndex));
            return;
          }
          if (Object.hasOwn(INTRINSICS, node.name)) {
            for (const argument of node.args) emit(argument);
            append(INTRINSICS[node.name].opcode);
            return;
          }
          const functionIndex = context.functionIndices.get(node.name);
          const builtinIndex = context.importedNames.indexOf(node.name);
          if (functionIndex === undefined && builtinIndex < 0) {
            compileError(`unknown function ${JSON.stringify(node.name)}`, node.token);
          }
          for (const argument of node.args) emit(argument);
          if (builtinIndex >= 0) {
            append(0x10, ...u32(builtinIndex));
          } else {
            append(0x10, ...u32(functionIndex));
          }
          return;
        }
        case "unary":
          emit(node.expression);
          if (node.op === "-") append(0x8c);
          else if (node.op === "!") {
            append(0x43, ...f32Bytes(0), 0x5b, 0xb2);
          }
          return;
        case "binary": {
          if (node.op === "%") {
            const base = context.layout.modTemps.get(node);
            emit(node.left);
            append(0x21, ...u32(base));
            emit(node.right);
            append(0x21, ...u32(base + 1));
            append(0x20, ...u32(base));
            append(0x20, ...u32(base));
            append(0x20, ...u32(base + 1));
            // f32.trunc is 0x8f.  0x90 is f32.nearest and would make
            // negative/positive remainders diverge from source `%` semantics.
            append(0x95, 0x8f);
            append(0x20, ...u32(base + 1), 0x94, 0x93);
            return;
          }
          if (node.op === "&&" || node.op === "||") {
            // Logical operators are short-circuiting and leave a canonical
            // f32 0/1 on the stack.  A result-valued WASM if keeps imports
            // such as input(), sound(), and tri() from running on a skipped
            // branch.
            emit(node.left);
            append(0x43, ...f32Bytes(0), 0x5c, 0x04, F32);
            if (node.op === "&&") {
              emit(node.right);
              append(0x43, ...f32Bytes(0), 0x5c, 0xb2, 0x05, 0x43, ...f32Bytes(0));
            } else {
              append(0x43, ...f32Bytes(1), 0x05);
              emit(node.right);
              append(0x43, ...f32Bytes(0), 0x5c, 0xb2);
            }
            append(0x0b);
            return;
          }
          emit(node.left);
          // The right operand is emitted after the logical branch above, so
          // ordinary binary operators continue to use the f32 stack order.
          emit(node.right);
          const arithmetic = {
            "+": 0x92,
            "-": 0x93,
            "*": 0x94,
            "/": 0x95,
            "==": 0x5b,
            "!=": 0x5c,
            "<": 0x5d,
            ">": 0x5e,
            "<=": 0x5f,
            ">=": 0x60,
          }[node.op];
          if (arithmetic === undefined) {
            compileError(`unsupported binary operator ${JSON.stringify(node.op)}`, node.token);
          }
          append(arithmetic);
          if (["==", "!=", "<", ">", "<=", ">="].includes(node.op)) append(0xb2);
          return;
        }
        default:
          compileError("internal error: unsupported expression node", node.token);
      }
    };
    emit(expression);
    return code;
  };

  function emitArrayInfo(node, context) {
    const arrayName = node.arrayName ?? node.name;
    const declaration = context.arrays.get(arrayName);
    const storage = context.arrayStorage.get(arrayName);
    if (!declaration || !storage || storage.offset === null) {
      compileError(`array ${JSON.stringify(arrayName)} has no materialized storage`, node.token);
    }
    return {declaration, storage};
  }

  function appendTrapIf(code, condition) {
    // A zero-result if containing unreachable is a compact, valid trap block.
    code.push(...condition, 0x04, 0x40, 0x00, 0x0b);
  }

  function emitCheckedArrayIndex(node, context, declaration, leaveLogicalIndex = false, elementBytes = 4) {
    const temp = context.layout.arrayTemps.get(node);
    if (temp === undefined) {
      compileError("internal error: missing array index temporary", node.token);
    }
    const code = [...emitExpr(node.index, context), 0x21, ...u32(temp)];
    const local = (...bytes) => [0x20, ...u32(temp), ...bytes];
    appendTrapIf(code, [...local(0x43, ...f32Bytes(0)), 0x5d]);
    appendTrapIf(code, [...local(), ...local(), 0x5c]);
    appendTrapIf(code, [...local(), 0x43, ...f32Bytes(declaration.length), 0x60]);
    appendTrapIf(code, [...local(), ...local(), 0x8f, 0x5c]);
    if (leaveLogicalIndex) {
      code.push(...local());
      return code;
    }
    if (elementBytes === 4) {
      // Keep the established f32-array sequence byte-for-byte identical.
      code.push(...local(), 0xa8, 0x41, 0x02, 0x74);
    } else if (elementBytes === 2) {
      code.push(...local(), 0xa8, 0x41, 0x01, 0x74);
    } else if (elementBytes === 1) {
      code.push(...local(), 0xa8);
    } else {
      throw new Error(`internal error: unsupported array element width ${elementBytes}`);
    }
    return code;
  }

  function emitArrayRead(node, context) {
    const {declaration, storage} = emitArrayInfo(node, context);
    if (storage.packing) {
      const decoderIndex = context.packedDecoderIndices.get(declaration.name);
      if (decoderIndex === undefined) {
        compileError(`internal error: missing packed decoder for array ${JSON.stringify(declaration.name)}`, node.token);
      }
      const code = emitCheckedArrayIndex(node, context, declaration, true);
      code.push(0x10, ...u32(decoderIndex));
      return code;
    }
    if (node.constantIndex !== undefined) {
      if (storage.encoding === "f32") {
        return memoryAccess(0x2a, storage.offset + node.constantIndex * 4);
      }
      const load = integerArrayLoad(storage.encoding);
      const address = storage.offset + node.constantIndex * storage.elementBytes;
      const alignment = address % storage.elementBytes === 0 ? load.alignment : 0x00;
      return [...memoryAccess(load.opcode, address, alignment), load.conversion];
    }
    const code = emitCheckedArrayIndex(node, context, declaration, false, storage.elementBytes);
    if (storage.encoding === "f32") {
      code.push(0x2a, 0x02, ...u32(storage.offset));
      return code;
    }
    const load = integerArrayLoad(storage.encoding);
    const alignment = storage.offset % storage.elementBytes === 0 ? load.alignment : 0x00;
    code.push(load.opcode, alignment, ...u32(storage.offset), load.conversion);
    return code;
  }

  const emitCondition = (expression, context) => {
    const comparisonOpcodes = {
      "==": 0x5b,
      "!=": 0x5c,
      "<": 0x5d,
      ">": 0x5e,
      "<=": 0x5f,
      ">=": 0x60,
    };
    const emit = (node) => {
      if (node.kind === "binary") {
        if (node.op === "&&" || node.op === "||") {
          const code = [...emit(node.left), 0x04, 0x7f];
          if (node.op === "&&") {
            code.push(...emit(node.right), 0x05, 0x41, 0x00);
          } else {
            code.push(0x41, 0x01, 0x05, ...emit(node.right));
          }
          code.push(0x0b);
          return code;
        }
        const opcode = comparisonOpcodes[node.op];
        if (opcode !== undefined) {
          return [...emitExpr(node.left, context), ...emitExpr(node.right, context), opcode];
        }
      }
      if (node.kind === "unary" && node.op === "!") {
        return [...emit(node.expression), 0x45];
      }
      return [...emitExpr(node, context), 0x43, ...f32Bytes(0), 0x5c];
    };
    return emit(expression);
  };

  const emitStatements = (statements, context) => {
    const code = [];
    const append = (...bytes) => code.push(...bytes);
    const isStrippedSvgMetadata = (expression) => !svgMetadata
      && expression.kind === "call"
      && (expression.name === SVG_METADATA_BUILTIN || expression.name === SVG_TRI_BUILTIN);
    for (const statement of statements) {
      switch (statement.kind) {
        case "let": {
          const index = context.layout.locals.get(statement.name);
          append(...emitExpr(statement.expression, context), 0x21, ...u32(index));
          break;
        }
        case "assign": {
          const index = context.layout.locals.get(statement.name);
          if (index !== undefined) {
            append(...emitExpr(statement.expression, context), 0x21, ...u32(index));
            break;
          }
          const globalIndex = context.globalIndices.get(statement.name);
          if (globalIndex === undefined) {
            compileError(`unknown local or global ${JSON.stringify(statement.name)}`, statement.token);
          }
          if (globalStorage === "globals") {
            append(...emitExpr(statement.expression, context), 0x24, ...u32(globalIndex));
          } else {
            append(...memoryStore(globalOffsets.get(statement.name), emitExpr(statement.expression, context)));
          }
          break;
        }
        case "arrayAssign": {
          const {declaration, storage} = emitArrayInfo(statement, context);
          if (statement.constantIndex !== undefined) {
            append(...memoryStore(
              storage.offset + statement.constantIndex * 4,
              emitExpr(statement.expression, context),
            ));
          } else {
            append(...emitCheckedArrayIndex(statement, context, declaration));
            append(...emitExpr(statement.expression, context));
            append(0x38, 0x02, ...u32(storage.offset));
          }
          break;
        }
        case "expr":
          if (isStrippedSvgMetadata(statement.expression)) break;
          append(...emitExpr(statement.expression, context), 0x1a);
          break;
        case "return":
          if (statement.expression) append(...emitExpr(statement.expression, context));
          else append(0x43, ...f32Bytes(0));
          append(0x0f);
          break;
        case "if":
          append(...emitCondition(statement.condition, context), 0x04, 0x40);
          append(...emitStatements(statement.thenBlock.body, context));
          if (statement.elseBlock) {
            append(0x05);
            append(...emitStatements(statement.elseBlock.body, context));
          }
          append(0x0b);
          break;
        case "while":
          append(0x02, 0x40, 0x03, 0x40);
          append(...emitCondition(statement.condition, context), 0x45, 0x0d, 0x01);
          append(...emitStatements(statement.body.body, context), 0x0c, 0x00, 0x0b, 0x0b);
          break;
        case "block":
          append(...emitStatements(statement.body, context));
          break;
        case "empty":
          break;
        default:
          compileError("internal error: unsupported statement node", statement.token);
      }
    }
    return code;
  };

  const emitPackedDecoder = (name) => {
    const storage = arrayStorageByName.get(name);
    const packing = storage?.packing;
    if (!storage || !packing || storage.offset === null) {
      throw new Error(`internal error: packed decoder has no materialized storage for ${JSON.stringify(name)}`);
    }
    const paletteOffset = storage.offset + packing.dataBytes.length;
    const paletteAlignment = paletteOffset % 4 === 0 ? 0x02 : 0x00;
    const localGet = (index) => [0x20, ...u32(index)];
    const localSet = (index) => [0x21, ...u32(index)];
    const i32Const = (value) => [0x41, ...s32(value)];

    // Parameters and locals are all f32/i32 values at the WASM boundary.  The
    // source-side checked index is converted once here, then split into the
    // seven-byte triangle record address and its logical lane.  The branch
    // keeps coordinate decoding signed while RGB lanes use the palette index
    // stored in the final record byte.
    const code = [
      ...localGet(0), 0xa8, ...localSet(1),
      ...localGet(1), ...i32Const(9), 0x6e, ...i32Const(7), 0x6c,
      ...i32Const(storage.offset), 0x6a, ...localSet(2),
      ...localGet(1), ...i32Const(9), 0x70, ...localSet(3),
      ...localGet(3), ...i32Const(6), 0x49,
      0x04, F32,
      ...localGet(2), ...localGet(3), 0x6a, 0x2c, 0x00, 0x00, 0xb2,
      0x05,
      ...localGet(2), ...i32Const(6), 0x6a, 0x2d, 0x00, 0x00, ...localSet(4),
      ...localGet(4), ...i32Const(12), 0x6c, ...i32Const(paletteOffset), 0x6a,
      ...localGet(3), ...i32Const(6), 0x6b, ...i32Const(4), 0x6c, 0x6a,
      0x2a, paletteAlignment, 0x00,
      0x0b,
      0x0b,
    ];
    const locals = [1, 4, 0x7f];
    return [...locals, ...code];
  };

  const codeBodies = [];
  for (const fn of reachability.reachable) {
    const context = contextFor(fn);
    const code = emitStatements(fn.body, context);
    code.push(0x43, ...f32Bytes(0), 0x0b);
    const localCount = context.layout.localCount - fn.params.length;
    const locals = localCount === 0 ? [0] : [1, ...u32(localCount), F32];
    const body = [...locals, ...code];
    codeBodies.push(...u32(body.length), ...body);
  }
  for (const name of packedDecoderNames) {
    const body = emitPackedDecoder(name);
    codeBodies.push(...u32(body.length), ...body);
  }

  const typePayload = [
    ...u32(types.length),
    ...types.flatMap((params) => [0x60, ...u32(params), ...Array(params).fill(F32), 1, F32]),
  ];
  const importPayload = [...u32(importedNames.length), ...imports];
  const memoryPages = Math.max(1, Math.ceil(allocatedBytes / 65536));
  const memoryPayload = [1, 0x00, ...u32(memoryPages)];
  const exportPayload = [
    3,
    ...stringBytes("init"), 0x00, ...u32(functionIndices.get("init")),
    ...stringBytes("frame"), 0x00, ...u32(functionIndices.get("frame")),
    ...stringBytes("memory"), 0x02, 0,
  ];
  const codePayload = [...u32(codeBodies.length > 0 ? reachability.reachable.length + packedDecoderNames.length : 0), ...codeBodies];
  const dataBytes = [
    ...(globalStorage === "memory" ? globals.flatMap((global) => f32Bytes(global.value)) : []),
    ...arrayStorage.flatMap((item) => {
      if (!item.materialized) return [];
      if (item.packing) return [...item.packing.dataBytes, ...item.packing.paletteBytes];
      if (item.encoding !== "f32") return integerArrayDataBytes(item.declaration.values, item.encoding);
      return item.declaration.values.flatMap((value) => f32Bytes(value));
    }),
  ];

  const bytes = [
    0x00, 0x61, 0x73, 0x6d,
    0x01, 0x00, 0x00, 0x00,
    ...section(1, typePayload),
    ...(importedNames.length ? section(2, importPayload) : []),
    ...section(3, [
      ...u32(reachability.reachable.length + packedDecoderNames.length),
      ...functionSection,
    ]),
    ...section(5, memoryPayload),
    ...(globalStorage === "globals" && globals.length ? section(6, [...u32(globals.length), ...globalsSection]) : []),
    ...section(7, exportPayload),
    ...section(10, codePayload),
    ...(dataBytes.length ? section(11, [
      1,
      0x00, 0x41, 0x00, 0x0b,
      ...u32(dataBytes.length),
      ...dataBytes,
    ]) : []),
  ];

  const arrayLayout = arrayStorage.map((item) => {
    const layout = {
      name: item.declaration.name,
      mutable: item.declaration.mutable,
      length: item.declaration.length,
      offset: item.offset,
      byteOffset: item.offset,
      byteLength: item.physicalByteLength,
      materialized: item.materialized,
      values: item.declaration.values.slice(),
    };
    if (item.packing) {
      layout.encoding = item.packing.encoding;
      layout.triangleCount = item.packing.triangleCount;
      layout.paletteSize = item.packing.paletteSize;
      if (item.materialized) {
        layout.paletteOffset = item.offset + item.packing.dataBytes.length;
      }
    } else if (item.encoding !== "f32") {
      layout.encoding = item.encoding;
      layout.elementBytes = item.elementBytes;
      layout.physicalByteLength = item.physicalByteLength;
    }
    return layout;
  });

  return {
    wasm: Uint8Array.from(bytes),
    imports: importedNames.slice(),
    functions: reachability.reachable.map((fn) => fn.name),
    globals: globals.map((global) => global.name),
    globalStorage,
    integerArrayStorage,
    svgMetadata,
    svgTriCallSites: svgTriCallSites.descriptors,
    arrays: arrayLayout,
    arrayLayout,
    memoryPages,
    allocatedBytes,
    totalArrayElements,
    maxArrayElements: MAX_ARRAY_ELEMENTS,
    ...(globalStorage === "memory" ? {globalLayout} : {}),
  };
}

/** Compile Slim source into a standalone WebAssembly binary. */
export function compile(source, options = {}) {
  return compileDetailed(source, options).wasm;
}

/**
 * Parse Slim source into the compiler's small frontend AST.  This is exported
 * for sibling backends (such as the JavaScript size comparison) so they can
 * share the language grammar and diagnostics without reimplementing a parser.
 */
export function parseProgram(source) {
  if (typeof source !== "string") {
    throw new TypeError("Slim compile error: source must be a string");
  }
  return new Parser(source).parse();
}

/**
 * Compile Slim source and return the binary plus small build-time metadata.
 * Metadata is intentionally not encoded into the WebAssembly module.
 */
export function compileDetailed(source, options = {}) {
  if (typeof source !== "string") {
    throw new TypeError("Slim compile error: source must be a string");
  }
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Slim compile error: options must be an object");
  }
  const optionNames = Object.keys(options);
  const unsupported = optionNames.find((name) => (
    name !== "globalStorage" && name !== "packedTriangleArrays" && name !== "integerArrayStorage" && name !== "svgMetadata"
  ));
  if (unsupported) {
    throw new TypeError(`Slim compile error: unsupported option ${JSON.stringify(unsupported)}`);
  }
  const globalStorage = options.globalStorage ?? "globals";
  if (globalStorage !== "globals" && globalStorage !== "memory") {
    throw new TypeError(`Slim compile error: globalStorage must be "globals" or "memory", got ${JSON.stringify(globalStorage)}`);
  }
  const integerArrayStorage = options.integerArrayStorage === undefined
    ? "f32"
    : options.integerArrayStorage;
  if (integerArrayStorage !== "f32" && integerArrayStorage !== "compact") {
    throw new TypeError(`Slim compile error: integerArrayStorage must be "f32" or "compact", got ${JSON.stringify(integerArrayStorage)}`);
  }
  const svgMetadata = options.svgMetadata ?? false;
  if (typeof svgMetadata !== "boolean") {
    throw new TypeError(`Slim compile error: svgMetadata must be true or false, got ${JSON.stringify(svgMetadata)}`);
  }
  const packedTriangleArrays = options.packedTriangleArrays === undefined
    ? []
    : options.packedTriangleArrays;
  if (!Array.isArray(packedTriangleArrays)) {
    throw new TypeError("Slim compile error: packedTriangleArrays must be an array of array names");
  }
  const packedNames = new Set();
  for (const name of packedTriangleArrays) {
    if (typeof name !== "string") {
      throw new TypeError("Slim compile error: packedTriangleArrays entries must be strings");
    }
    if (packedNames.has(name)) {
      throw new TypeError(`Slim compile error: duplicate packed triangle array ${JSON.stringify(name)}`);
    }
    packedNames.add(name);
  }
  const program = parseProgram(source);
  return emitModule(program, {
    globalStorage,
    integerArrayStorage,
    packedTriangleArrays: [...packedNames],
    svgMetadata,
  });
}

export default compile;
