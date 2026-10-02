import {
  MINIFIED_WASM_EXPORT_NAMES,
  MINIFIED_WASM_IMPORT_NAMES,
} from '../src/host.mjs';

const MAGIC = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const CUSTOM_SECTIONS_TO_DROP = new Set([
  'name',
  'producers',
  'sourceMappingURL',
  'external_debug_info',
]);

function asBytes(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  throw new TypeError('wasmBytes must be an ArrayBuffer or a byte view');
}

function readVarUint(bytes, offset, limit) {
  let value = 0;
  let shift = 0;
  for (let index = 0; index < 5; index++) {
    if (offset >= limit) throw new TypeError('Truncated WASM integer');
    const byte = bytes[offset++];
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) {
      if (value > 0xffffffff) throw new TypeError('WASM integer exceeds u32');
      return {value, offset};
    }
    shift += 7;
  }
  throw new TypeError('Invalid WASM integer');
}

function varUint(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new TypeError('WASM integer must be a u32');
  }
  const bytes = [];
  do {
    const low = value % 128;
    value = Math.floor(value / 128);
    bytes.push(low | (value ? 0x80 : 0));
  } while (value);
  return bytes;
}

function readName(bytes, offset, limit) {
  const length = readVarUint(bytes, offset, limit);
  const end = length.offset + length.value;
  if (end > limit) throw new TypeError('Truncated WASM name');
  let value;
  try {
    value = new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(length.offset, end));
  } catch {
    throw new TypeError('WASM names must be valid UTF-8');
  }
  return {value, offset: end};
}

function nameBytes(value) {
  const bytes = new TextEncoder().encode(value);
  return [...varUint(bytes.length), ...bytes];
}

function joinBytes(parts) {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function rewriteImports(bytes, start, end) {
  let cursor = start;
  const count = readVarUint(bytes, cursor, end);
  cursor = count.offset;
  const fields = new Set();
  const payload = [...varUint(count.value)];
  for (let index = 0; index < count.value; index++) {
    const moduleName = readName(bytes, cursor, end);
    const fieldName = readName(bytes, moduleName.offset, end);
    cursor = fieldName.offset;
    if (cursor >= end) throw new TypeError('Truncated WASM import');
    const kind = bytes[cursor++];
    if (kind !== 0) throw new Error('Only function imports can be compacted');
    const typeIndex = readVarUint(bytes, cursor, end);
    cursor = typeIndex.offset;
    const compactName = MINIFIED_WASM_IMPORT_NAMES[fieldName.value];
    if (moduleName.value !== 'e' || !compactName) {
      throw new Error(`Unsupported WASM import ${moduleName.value}.${fieldName.value}`);
    }
    if (fields.has(compactName)) throw new Error(`Duplicate WASM import ${moduleName.value}.${fieldName.value}`);
    fields.add(compactName);
    payload.push(...nameBytes(moduleName.value), ...nameBytes(compactName), kind, ...varUint(typeIndex.value));
  }
  if (cursor !== end) throw new TypeError('Unexpected bytes in WASM import section');
  return Uint8Array.from(payload);
}

function rewriteExports(bytes, start, end) {
  let cursor = start;
  const count = readVarUint(bytes, cursor, end);
  cursor = count.offset;
  const payload = [];
  let rewrittenCount = 0;
  const names = new Set();
  for (let index = 0; index < count.value; index++) {
    const name = readName(bytes, cursor, end);
    cursor = name.offset;
    if (cursor >= end) throw new TypeError('Truncated WASM export');
    const kind = bytes[cursor++];
    const itemIndex = readVarUint(bytes, cursor, end);
    cursor = itemIndex.offset;

    if (name.value === 'memory' && kind === 2) continue;
    const compactName = MINIFIED_WASM_EXPORT_NAMES[name.value];
    if (kind !== 0 || !compactName) {
      throw new Error(`Unsupported WASM export ${name.value} (${kind})`);
    }
    if (names.has(compactName)) throw new Error(`Duplicate WASM export ${name.value}`);
    names.add(compactName);
    rewrittenCount++;
    payload.push(...nameBytes(compactName), kind, ...varUint(itemIndex.value));
  }
  if (cursor !== end) throw new TypeError('Unexpected bytes in WASM export section');
  if (rewrittenCount !== 2 || !names.has('a') || !names.has('b')) {
    throw new Error('WASM must export init, frame, and memory before interface compaction');
  }
  return joinBytes([Uint8Array.from(varUint(rewrittenCount)), Uint8Array.from(payload)]);
}

function rewriteCustomSection(bytes, start, end) {
  const name = readName(bytes, start, end);
  const isDebug = name.value.startsWith('.debug_') || name.value.startsWith('reloc.');
  return CUSTOM_SECTIONS_TO_DROP.has(name.value) || isDebug
    ? null
    : bytes.subarray(start, end);
}

/**
 * Rename the compiler's public host imports and two required exports for a
 * shipping module, remove its unused memory export, and discard debug names.
 * The public compiler output is left unchanged; makeHtml detects this exact
 * compact interface and supplies the matching host keys and export lookups.
 */
export function minifyWasmInterface(wasmBytes) {
  const bytes = asBytes(wasmBytes);
  if (bytes.length < MAGIC.length || !MAGIC.every((byte, index) => bytes[index] === byte)) {
    throw new TypeError('wasmBytes must be a valid version 1 WASM module');
  }

  let source;
  try {
    source = new WebAssembly.Module(bytes);
  } catch (error) {
    throw new TypeError(`wasmBytes must be a valid WASM module: ${error.message}`);
  }
  const imports = WebAssembly.Module.imports(source);
  const exports = WebAssembly.Module.exports(source);
  for (const descriptor of imports) {
    if (descriptor.kind !== 'function' || descriptor.module !== 'e' || !MINIFIED_WASM_IMPORT_NAMES[descriptor.name]) {
      throw new Error(`Unsupported WASM import ${descriptor.module}.${descriptor.name} (${descriptor.kind})`);
    }
  }
  const expectedExports = new Map([
    ['init', 'function'],
    ['frame', 'function'],
    ['memory', 'memory'],
  ]);
  if (exports.length !== expectedExports.size || exports.some(({name, kind}) => expectedExports.get(name) !== kind)) {
    throw new Error('WASM must export exactly init, frame, and memory before interface compaction');
  }

  const sections = [Uint8Array.from(MAGIC)];
  let offset = MAGIC.length;
  let sawImports = false;
  let sawExports = false;
  while (offset < bytes.length) {
    const sectionId = bytes[offset++];
    const size = readVarUint(bytes, offset, bytes.length);
    const start = size.offset;
    const end = start + size.value;
    if (end > bytes.length) throw new TypeError('Truncated WASM section');
    let payload = bytes.subarray(start, end);

    if (sectionId === 2) {
      if (sawImports) throw new TypeError('Duplicate WASM import section');
      sawImports = true;
      payload = rewriteImports(bytes, start, end);
    } else if (sectionId === 7) {
      if (sawExports) throw new TypeError('Duplicate WASM export section');
      sawExports = true;
      payload = rewriteExports(bytes, start, end);
    } else if (sectionId === 0) {
      payload = rewriteCustomSection(bytes, start, end);
      if (payload === null) {
        offset = end;
        continue;
      }
    }

    sections.push(Uint8Array.of(sectionId), Uint8Array.from(varUint(payload.length)), payload);
    offset = end;
  }
  if (!sawExports) throw new TypeError('WASM is missing its export section');

  const compact = joinBytes(sections);
  if (!WebAssembly.validate(compact)) throw new TypeError('WASM interface compaction produced an invalid module');
  const compactModule = new WebAssembly.Module(compact);
  const compactImports = WebAssembly.Module.imports(compactModule);
  const compactExports = WebAssembly.Module.exports(compactModule);
  if (compactImports.some(({module, name, kind}) => module !== 'e' || kind !== 'function' || !Object.values(MINIFIED_WASM_IMPORT_NAMES).includes(name))) {
    throw new Error('WASM import mapping did not validate');
  }
  if (compactExports.length !== 2 || compactExports.some(({name, kind}) => kind !== 'function' || !Object.values(MINIFIED_WASM_EXPORT_NAMES).includes(name))) {
    throw new Error('WASM export mapping did not validate');
  }
  return compact;
}
