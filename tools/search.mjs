/**
 * Run a bounded coordinate search over complete candidate evaluations.
 *
 * `initial` is the first settings object.  Each axis returns the values that
 * should be tried while the other settings stay at the current winner.  The
 * evaluator owns any memoization it needs and returns the best complete
 * candidate for each settings object (for example, after comparing minified
 * and unminified HTML).  Candidates are compared from best to worst.
 *
 * @param {{
 *   initial: object,
 *   axes: Array<{name: string, choices: (currentCandidate: object) => Iterable<unknown>|Promise<Iterable<unknown>>}>,
 *   evaluate: (settings: object) => Promise<object>|object,
 *   compare: (left: object, right: object) => number,
 *   maxPasses?: number,
 * }} options
 * @returns {Promise<{best: object, stages: Array<{
 *   pass: number,
 *   axis: string,
 *   before: object|null,
 *   after: object,
 *   trials: object[],
 * }>}>}
 */
export async function stagedSearch({initial, axes, evaluate, compare, maxPasses = 2}) {
  if (initial === null || typeof initial !== 'object' || Array.isArray(initial)) {
    throw new TypeError('stagedSearch initial must be an object');
  }
  if (!Array.isArray(axes) || axes.some((axis) => (
    axis === null || typeof axis !== 'object' || typeof axis.name !== 'string' ||
    typeof axis.choices !== 'function'
  ))) {
    throw new TypeError('stagedSearch axes must contain {name, choices} objects');
  }
  if (typeof evaluate !== 'function') throw new TypeError('stagedSearch evaluate must be a function');
  if (typeof compare !== 'function') throw new TypeError('stagedSearch compare must be a function');
  if (!Number.isInteger(maxPasses) || maxPasses <= 0) {
    throw new RangeError('stagedSearch maxPasses must be a positive integer');
  }

  let settings = {...initial};
  let best = await evaluate({...settings});
  if (best === null || typeof best !== 'object') {
    throw new TypeError('stagedSearch evaluate must return a candidate object');
  }
  for (const axis of axes) {
    if (Object.hasOwn(best, axis.name)) settings[axis.name] = best[axis.name];
  }
  const stages = [{
    pass: 0,
    axis: 'baseline',
    before: null,
    after: best,
    trials: [best],
  }];

  for (let pass = 1; pass <= maxPasses; pass += 1) {
    const passBefore = best;
    for (const axis of axes) {
      const before = best;
      // Include the settings alongside the evaluated candidate.  This keeps
      // the helper useful when an evaluator returns only measurement fields,
      // while preserving the documented current-candidate API.
      const current = {...settings, ...before};
      const requestedChoices = await axis.choices(current);
      const choices = requestedChoices == null ? [] : [...requestedChoices];
      const trials = [];
      let selected = before;
      let selectedSettings = settings;

      for (const choice of choices) {
        let trialSettings;
        if (choice !== null && typeof choice === 'object' && !Array.isArray(choice) && Object.hasOwn(choice, axis.name)) {
          trialSettings = {...settings, ...choice};
        } else {
          trialSettings = {...settings, [axis.name]: choice};
        }
        const candidate = await evaluate({...trialSettings});
        if (candidate === null || typeof candidate !== 'object') {
          throw new TypeError('stagedSearch evaluate must return a candidate object');
        }
        trials.push(candidate);
        if (compare(candidate, selected) < 0) {
          selected = candidate;
          selectedSettings = trialSettings;
        }
      }

      best = selected;
      for (const candidateAxis of axes) {
        if (Object.hasOwn(selected, candidateAxis.name)) {
          selectedSettings = {...selectedSettings, [candidateAxis.name]: selected[candidateAxis.name]};
        }
      }
      settings = selectedSettings;
      stages.push({pass, axis: axis.name, before, after: best, trials});
    }
    if (compare(passBefore, best) === 0) break;
  }

  return {best, stages};
}

export default stagedSearch;
