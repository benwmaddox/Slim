// Independent Sokoban solver for the Crate Shift levels. It uses the same flat
// 9x8 cell layout as examples/boxpush.slim but none of its game code, so a
// solution found here is an honest check that each level can be beaten with
// pushes only (the game has no pull move).
export const STRIDE = 9;
export const ROWS = 8;
export const CELLS = STRIDE * ROWS;
export const DELTAS = {left: -1, right: 1, up: -STRIDE, down: STRIDE};
export const DIRECTIONS = Object.keys(DELTAS);

const V = 0, WALL = 1, FLOOR = 2, TARGET = 3;

// Decode a level from the arrays in the slim source into a small model.
export function decodeLevel(map, boxes, start, width, height) {
  const level = {map: [...map], boxes: [], start, width, height, targets: []};
  for (let i = 0; i < CELLS; i += 1) {
    if (boxes[i]) level.boxes.push(i);
    if (map[i] === TARGET) level.targets.push(i);
  }
  return level;
}

// Every walkable cell must be fenced by walls: movement uses flat +/-1 and +/-9
// steps, so a leak at the edge of a row would wrap into the neighbouring row.
export function validateLevel(level) {
  const errors = [];
  const walkable = (i) => level.map[i] === FLOOR || level.map[i] === TARGET;
  for (let i = 0; i < CELLS; i += 1) {
    if (!walkable(i)) continue;
    const x = i % STRIDE, y = Math.floor(i / STRIDE);
    if (x === 0 || y === 0 || x === STRIDE - 1 || y === ROWS - 1) errors.push(`cell ${i} touches the grid edge`);
    for (const d of Object.values(DELTAS)) if (level.map[i + d] === V) errors.push(`cell ${i} opens onto void`);
  }
  if (!walkable(level.start)) errors.push('player starts off the floor');
  if (level.boxes.length !== level.targets.length) errors.push('box and target counts differ');
  for (const b of level.boxes) if (!walkable(b)) errors.push(`box ${b} is off the floor`);
  if (level.boxes.includes(level.start)) errors.push('player starts on a box');
  return errors;
}

export function isSolved(level, boxes) {
  return boxes.every((b) => level.map[b] === TARGET);
}

// A crate pushed into a corner (walls on two perpendicular sides) that is not a
// target can never move again, so the search can drop that state. This only
// removes unsolvable states, so the fewest-pushes answer is unchanged.
function frozenInCorner(level, cell) {
  if (level.map[cell] === TARGET) return false;
  const blocked = (d) => level.map[cell + d] !== FLOOR && level.map[cell + d] !== TARGET;
  return (blocked(-1) || blocked(1)) && (blocked(-STRIDE) || blocked(STRIDE));
}

function reach(level, player, boxSet) {
  const seen = new Map([[player, null]]);
  const queue = [player];
  for (let head = 0; head < queue.length; head += 1) {
    const cell = queue[head];
    for (const dir of DIRECTIONS) {
      const next = cell + DELTAS[dir];
      const kind = level.map[next];
      if (seen.has(next) || boxSet.has(next) || (kind !== FLOOR && kind !== TARGET)) continue;
      seen.set(next, {from: cell, dir});
      queue.push(next);
    }
  }
  return seen;
}

function path(seen, to) {
  const moves = [];
  for (let step = seen.get(to); step; step = seen.get(step.from)) moves.push(step.dir);
  return moves.reverse();
}

// Breadth-first over pushes, so the result has the fewest pushes. Returns
// {pushes, moves: ['right', ...]} or null when no solution exists.
export function solve(level, limit = 3_000_000) {
  const key = (player, boxes) => `${player}|${[...boxes].sort((a, b) => a - b).join(',')}`;
  const startBoxes = new Set(level.boxes);
  const startReach = reach(level, level.start, startBoxes);
  const canon = (seen) => Math.min(...seen.keys());
  const startKey = key(canon(startReach), startBoxes);
  const parents = new Map([[startKey, null]]);
  let frontier = [{player: level.start, boxes: startBoxes, key: startKey}];
  if (isSolved(level, level.boxes)) return {pushes: 0, moves: []};
  let visited = 1;
  while (frontier.length) {
    const next = [];
    for (const state of frontier) {
      const seen = reach(level, state.player, state.boxes);
      for (const box of state.boxes) {
        for (const dir of DIRECTIONS) {
          const d = DELTAS[dir];
          const from = box - d, to = box + d;
          const kind = level.map[to];
          if (!seen.has(from) || state.boxes.has(to) || (kind !== FLOOR && kind !== TARGET)) continue;
          if (frozenInCorner(level, to)) continue;
          const boxes = new Set(state.boxes);
          boxes.delete(box);
          boxes.add(to);
          const after = reach(level, box, boxes);
          const k = key(canon(after), boxes);
          if (parents.has(k)) continue;
          visited += 1;
          if (visited > limit) throw new Error('search limit exceeded');
          parents.set(k, {prev: state, from, dir, seen});
          const node = {player: box, boxes, key: k};
          if (isSolved(level, [...boxes])) return {pushes: depth(parents, k), moves: expand(parents, k)};
          next.push(node);
        }
      }
    }
    frontier = next;
  }
  return null;
}

function depth(parents, k) {
  let n = 0;
  for (let p = parents.get(k); p; p = parents.get(p.prev.key)) n += 1;
  return n;
}

function expand(parents, k) {
  const segments = [];
  for (let p = parents.get(k); p; p = parents.get(p.prev.key)) {
    segments.push([...path(p.seen, p.from), p.dir]);
  }
  return segments.reverse().flat();
}

// Apply one move exactly like the game's rules (push only, one box at a time).
export function step(level, state, dir) {
  const d = DELTAS[dir];
  const target = state.player + d;
  const kind = level.map[target];
  if (kind !== FLOOR && kind !== TARGET) return false;
  const boxIndex = state.boxes.indexOf(target);
  if (boxIndex >= 0) {
    const beyond = target + d;
    const beyondKind = level.map[beyond];
    if ((beyondKind !== FLOOR && beyondKind !== TARGET) || state.boxes.includes(beyond)) return false;
    state.boxes[boxIndex] = beyond;
  }
  state.player = target;
  return true;
}
