/*
 * Slim v0 compiler
 *
 * This is deliberately a small, freestanding compiler.  The compiler itself
 * runs on Node, while the result is a plain WebAssembly module with no runtime
 * dependencies.  Values at the language boundary are f32; predicates are
 * represented as f32 0/1 values so game code can use them in arithmetic too.
 */

const BUILTIN_ORDER = ["tri", "sound", "input"];

const BUILTINS = Object.freeze({
  tri: Object.freeze({ params: 9, result: true }),
  sound: Object.freeze({ params: 3, result: true }),
  input: Object.freeze({ params: 1, result: true }),
});

const F32 = 0x7d;

function compileError(message, token) {
  const line = token?.line ?? 1;
  const column = token?.column ?? 1;
  throw new SyntaxError(`Slim compile error at ${line}:${column}: ${message}`);
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

      if ("{}(),;=+-*/%<>!".includes(ch)) {
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
    const globalNames = new Set();
    const functions = new Map();

    while (this.peek().kind !== "eof") {
      const token = this.peek();
      if (token.kind !== "id") {
        compileError(`expected top-level global or fn, found ${JSON.stringify(token.value)}`, token);
      }
      if (token.value === "global") {
        const global = this.parseGlobal();
        if (globalNames.has(global.name)) {
          compileError(`duplicate global ${JSON.stringify(global.name)}`, global.token);
        }
        globalNames.add(global.name);
        globals.push(global);
      } else if (token.value === "fn") {
        const fn = this.parseFunction();
        if (functions.has(fn.name)) {
          compileError(`duplicate function ${JSON.stringify(fn.name)}`, fn.token);
        }
        if (Object.hasOwn(BUILTINS, fn.name)) {
          compileError(`function name ${JSON.stringify(fn.name)} is reserved for a builtin`, fn.token);
        }
        functions.set(fn.name, fn);
      } else {
        compileError(`expected top-level global or fn, found ${JSON.stringify(token.value)}`, token);
      }
    }

    return { globals, functions };
  }

  parseGlobal() {
    const token = this.expect("global");
    const name = this.expectIdentifier("global name");
    this.expect("=");
    const expression = this.parseExpression();
    this.expect(";");
    return { kind: "global", name: name.value, expression, token };
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

function evalConstant(expression) {
  switch (expression.kind) {
    case "num":
      return Math.fround(expression.value);
    case "unary": {
      const value = evalConstant(expression.expression);
      if (expression.op === "+") return value;
      if (expression.op === "-") return Math.fround(-value);
      if (expression.op === "!") return value === 0 ? 1 : 0;
      break;
    }
    case "binary": {
      const left = evalConstant(expression.left);
      const right = evalConstant(expression.right);
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
  compileError("global initializers must be constant numeric expressions", expression.token);
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

function prepareReachability(program) {
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
        const builtin = Object.hasOwn(BUILTINS, node.name) ? BUILTINS[node.name] : undefined;
        if (builtin) {
          builtinNames.add(node.name);
          if (node.args.length !== builtin.params) {
            compileError(`builtin ${JSON.stringify(node.name)} expects ${builtin.params} arguments, got ${node.args.length}`, node.token);
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
    }
  };
  const collectStatementExpressions = (statements) => {
    for (const statement of statements) {
      if (statement.kind === "let" || statement.kind === "assign" || statement.kind === "expr") {
        collectExpression(statement.expression);
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

  // Keep this argument as part of the layout helper so the resolver stays the
  // single place where source names are checked.  Globals are immutable but
  // are valid expression names.
  void globalNames;
  return {
    locals,
    localCount: declarations.length + fn.params.length + modCount * 2,
    modTemps,
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

function stringBytes(value) {
  const bytes = Array.from(new TextEncoder().encode(value));
  return [...u32(bytes.length), ...bytes];
}

function f32Bytes(value) {
  const buffer = new ArrayBuffer(4);
  new DataView(buffer).setFloat32(0, value, true);
  return Array.from(new Uint8Array(buffer));
}

function section(id, payload) {
  return [id, ...u32(payload.length), ...payload];
}

function typeKey(params) {
  return `${params}=>1`;
}

function emitModule(program) {
  const globals = program.globals.map((global) => ({
    name: global.name,
    value: evalConstant(global.expression),
  }));
  const globalIndices = new Map(globals.map((global, index) => [global.name, index]));
  const globalNames = new Set(globalIndices.keys());

  const reachability = prepareReachability(program);
  const importedNames = reachability.importedBuiltins;

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

  const globalsSection = [];
  for (const global of globals) {
    // v0 globals are mutable so the game can keep compact state in the module
    // without introducing a heap or a separate state ABI.
    globalsSection.push(F32, 0x01, 0x43, ...f32Bytes(global.value), 0x0b);
  }

  const contextFor = (fn) => ({
    fn,
    layout: layouts.get(fn.name),
    globalIndices,
    functionIndices,
    importedNames,
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
          const globalIndex = context.globalIndices.get(node.name);
          if (globalIndex !== undefined) {
            append(0x23, ...u32(globalIndex));
            return;
          }
          compileError(`unknown value ${JSON.stringify(node.name)}`, node.token);
          return;
        }
        case "call": {
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
            append(0x95, 0x90);
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

  const emitCondition = (expression, context) => [
    ...emitExpr(expression, context),
    0x43,
    ...f32Bytes(0),
    0x5c,
  ];

  const emitStatements = (statements, context) => {
    const code = [];
    const append = (...bytes) => code.push(...bytes);
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
          append(...emitExpr(statement.expression, context), 0x24, ...u32(globalIndex));
          break;
        }
        case "expr":
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

  const typePayload = [
    ...u32(types.length),
    ...types.flatMap((params) => [0x60, ...u32(params), ...Array(params).fill(F32), 1, F32]),
  ];
  const importPayload = [...u32(importedNames.length), ...imports];
  const memoryPayload = [1, 0x00, 1];
  const exportPayload = [
    3,
    ...stringBytes("init"), 0x00, ...u32(functionIndices.get("init")),
    ...stringBytes("frame"), 0x00, ...u32(functionIndices.get("frame")),
    ...stringBytes("memory"), 0x02, 0,
  ];
  const codePayload = [...u32(codeBodies.length > 0 ? reachability.reachable.length : 0), ...codeBodies];

  const bytes = [
    0x00, 0x61, 0x73, 0x6d,
    0x01, 0x00, 0x00, 0x00,
    ...section(1, typePayload),
    ...(importedNames.length ? section(2, importPayload) : []),
    ...section(3, [
      ...u32(reachability.reachable.length),
      ...functionSection,
    ]),
    ...section(5, memoryPayload),
    ...(globals.length ? section(6, [...u32(globals.length), ...globalsSection]) : []),
    ...section(7, exportPayload),
    ...section(10, codePayload),
  ];

  return {
    wasm: Uint8Array.from(bytes),
    imports: importedNames.slice(),
    functions: reachability.reachable.map((fn) => fn.name),
    globals: globals.map((global) => global.name),
  };
}

/** Compile Slim source into a standalone WebAssembly binary. */
export function compile(source) {
  return compileDetailed(source).wasm;
}

/**
 * Compile Slim source and return the binary plus small build-time metadata.
 * Metadata is intentionally not encoded into the WebAssembly module.
 */
export function compileDetailed(source) {
  if (typeof source !== "string") {
    throw new TypeError("Slim compile error: source must be a string");
  }
  const program = new Parser(source).parse();
  return emitModule(program);
}

export default compile;
