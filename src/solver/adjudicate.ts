import type {
  AdjudicationOutcome,
  Limits,
  Plan,
  Scenario,
  StepRecord,
  Violation,
  ViolationKind,
} from './types';

/**
 * 数值比较容差：质量/力臂为浮点录入，载荷与力矩的边界判定及力矩余量决胜使用。
 * 注意：安装代价不使用此容差——代价是逐位有意义的十进制录入值，
 * 改以精确十进制（大整数尾数）严格比较，见下方 Decimal。
 */
export const EPS = 1e-9;

/**
 * 十进制安装代价的精确表示。
 *
 * 代价来自文本录入的十进制值（如 0.1、0.3），而浮点二进制无法精确表示这些值：
 * 0.1 + 0.2 = 0.30000000000000004 ≠ 0.3。若直接按浮点严格比较，用户按十进制
 * 录入的同代价方案（0.1 + 0.2 与 0.3 + 0）会被判出成本差，序号决胜被绕过。
 * 因此裁决内部以 (整数尾数, 小数位数) 精确保存录入值并以未缩放大整数求和，
 * 使“按录入的十进制值同代价”的方案真正并列。
 *
 * 真实的成本差（哪怕极小，如 1e-10）依然是不同的录入十进制值，尾数不同，
 * 比较结果仍严格偏向较低成本，不会被此机制抹平。
 */
interface Decimal {
  /** 去掉小数点后的非负整数尾数，如 0.10 → 1。 */
  mantissa: bigint;
  /** 录入值的小数位数，如 "0.10" → 2。 */
  scale: number;
}

const decimalCache = new Map<number, Decimal>();

/**
 * 把数值化后的录入代价还原为精确十进制。parseDraft 由文本经 Number() 得到数值，
 * Number.toString 对合法录入产生其最简十进制（0.1→"0.1"、1e-10→"1e-10"），
 * 由此恢复与用户录入逐位等价的尾数；代价规模与块数（≤7）都很小，尾数不会越界。
 */
function toDecimal(value: number): Decimal {
  const cached = decimalCache.get(value);
  if (cached) return cached;
  const s = String(value);
  let mantissa: bigint;
  let scale: number;
  const expMatch = /[eE]/.test(s) ? s.match(/^(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/) : null;
  if (expMatch) {
    const [, intPart, fracPart = '', expRaw] = expMatch;
    const digits = intPart + fracPart;
    const exp = Number(expRaw) - fracPart.length;
    if (exp >= 0) {
      mantissa = BigInt(digits) * 10n ** BigInt(exp);
      scale = 0;
    } else {
      mantissa = BigInt(digits);
      scale = -exp;
    }
  } else {
    const [intPart, fracPart = ''] = s.split('.');
    mantissa = BigInt(intPart + fracPart);
    scale = fracPart.length;
  }
  const d = { mantissa, scale };
  decimalCache.set(value, d);
  return d;
}

/** 精确十进制总和：各加数按最大小数位放大为整数后相加。 */
function addDecimal(a: Decimal, b: Decimal): Decimal {
  const scale = Math.max(a.scale, b.scale);
  const mantissa = a.mantissa * 10n ** BigInt(scale - a.scale) + b.mantissa * 10n ** BigInt(scale - b.scale);
  return { mantissa, scale };
}

/** 精确比较两个十进制总和：负数表示 a < b，0 表示按录入十进制值相等。 */
function compareDecimal(a: Decimal, b: Decimal): number {
  const diff = a.mantissa * 10n ** BigInt(b.scale) - b.mantissa * 10n ** BigInt(a.scale);
  return diff < 0n ? -1 : diff > 0n ? 1 : 0;
}

interface FlatOption {
  optionIndex: number;
  railId: string;
  railName: string;
  coordinate: number;
  cost: number;
  /** 录入代价的精确十进制表示（决胜与总代价均以此为准）。 */
  costDecimal: Decimal;
}

interface FlatBlock {
  index: number;
  name: string;
  mass: number;
  options: FlatOption[];
}

/** 把精确十进制总和转回数值用于结果展示（本身仍是最接近该十进制值的浮点）。 */
function decimalToNumber(d: Decimal): number {
  if (d.scale === 0) return Number(d.mantissa);
  const digits = d.mantissa.toString().padStart(d.scale + 1, '0');
  return Number(`${digits.slice(0, -d.scale)}.${digits.slice(-d.scale)}`);
}

function torqueMarginOf(torque: number, limits: Limits): number {
  return Math.min(torque - limits.minTorque, limits.maxTorque - torque);
}

/** 按 (块录入序号, 位置录入序号) 沿挂装次序逐位比较，保证稳定决胜。 */
function lexCompareSteps(a: StepRecord[], b: StepRecord[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i].blockIndex !== b[i].blockIndex) return a[i].blockIndex - b[i].blockIndex;
    if (a[i].optionIndex !== b[i].optionIndex) return a[i].optionIndex - b[i].optionIndex;
  }
  return a.length - b.length;
}

/** 搜索内部使用的方案：在对外 Plan 之上附带精确十进制总代价。 */
interface SearchPlan extends Plan {
  costExact: Decimal;
}

/**
 * 裁决优先级（依次）：
 * 1. 力矩余量（所有前缀中的最小值）最大者优先；
 * 2. 总安装代价最小者优先——按录入十进制值精确比较：用户按十进制录入的同代价
 *    方案（如 0.1+0.2 与 0.3+0）视为并列；任何真实差异（哪怕仅 1e-10）尾数不同，
 *    仍严格偏向较低成本，序号决胜不得覆盖成本差；
 * 3. 按挂装顺序的 (块录入序号, 位置录入序号) 序列字典序最小者优先。
 */
function isBetter(a: SearchPlan, b: SearchPlan | null): boolean {
  if (b === null) return true;
  if (a.minTorqueMargin > b.minTorqueMargin + EPS) return true;
  if (a.minTorqueMargin < b.minTorqueMargin - EPS) return false;
  const costCmp = compareDecimal(a.costExact, b.costExact);
  if (costCmp < 0) return true;
  if (costCmp > 0) return false;
  return lexCompareSteps(a.steps, b.steps) < 0;
}

/**
 * 裁决：联合确定每块配重恰用一次的挂入位置与完整挂装次序。
 *
 * 搜索按挂装顺序逐步进行，每一个前缀状态都同时校验总载荷与力矩闭区间，
 * 因此绝不出现“先定最终位置再事后排序”的情况；力矩余量沿前缀单调不增、
 * 总代价单调不减（代价非负），据此对当前最优解做分支限界。
 * 总代价以精确十进制（未缩放大整数）累加，整数加法满足结合/交换律，
 * 故随挂装次序递增累加与规范求和逐位相同。
 */
export function adjudicate(scenario: Scenario): AdjudicationOutcome {
  const railById = new Map(scenario.rails.map((r) => [r.id, r]));
  const blocks: FlatBlock[] = scenario.blocks.map((b, i) => ({
    index: i,
    name: b.name,
    mass: b.mass,
    options: b.options.map((o, j) => {
      const rail = railById.get(o.railId);
      if (!rail) throw new Error(`未知导轨位置: ${o.railId}`);
      return {
        optionIndex: j,
        railId: rail.id,
        railName: rail.name,
        coordinate: rail.coordinate,
        cost: o.cost,
        costDecimal: toDecimal(o.cost),
      };
    }),
  }));
  const n = blocks.length;
  const limits = scenario.limits;

  const used = new Array<boolean>(n).fill(false);
  const steps: StepRecord[] = [];
  let best: SearchPlan | null = null;
  /** 每个深度上按裁决优先级最优的可行前缀（用于无可行方案时的诊断）。 */
  const bestPartial: (SearchPlan | null)[] = new Array(n + 1).fill(null);

  const snapshot = (costExact: Decimal, minTorqueMargin: number): SearchPlan => ({
    steps: steps.map((s) => ({ ...s })),
    totalCost: decimalToNumber(costExact),
    costExact,
    minTorqueMargin,
    finalMass: steps.length > 0 ? steps[steps.length - 1].cumulativeMass : 0,
    finalTorque: steps.length > 0 ? steps[steps.length - 1].cumulativeTorque : 0,
  });

  const dfs = (depth: number, mass: number, torque: number, totalCost: Decimal, minMargin: number): void => {
    const current = snapshot(totalCost, minMargin);
    if (isBetter(current, bestPartial[depth])) bestPartial[depth] = current;
    if (depth === n) {
      if (isBetter(current, best)) best = current;
      return;
    }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      const block = blocks[i];
      for (const opt of block.options) {
        const massAfter = mass + block.mass;
        if (massAfter > limits.maxLoad + EPS) continue;
        const torqueAfter = torque + block.mass * opt.coordinate;
        if (torqueAfter < limits.minTorque - EPS || torqueAfter > limits.maxTorque + EPS) continue;
        const margin = torqueMarginOf(torqueAfter, limits);
        const nextMinMargin = Math.min(minMargin, margin);
        const nextCost = addDecimal(totalCost, opt.costDecimal);
        if (best) {
          // 力矩余量已严格劣于最优解，剪枝。
          if (nextMinMargin < best.minTorqueMargin - EPS) continue;
          // 余量无法严格更优，而代价（非负，继续挂装只会更高）已严格更贵，剪枝。
          // 精确十进制比较：录入值确有差异（哪怕仅 1e-10）也必须保留更便宜的分支。
          if (nextMinMargin < best.minTorqueMargin + EPS && compareDecimal(nextCost, best.costExact) > 0) {
            continue;
          }
        }
        used[i] = true;
        steps.push({
          blockIndex: i,
          blockName: block.name,
          optionIndex: opt.optionIndex,
          railId: opt.railId,
          railName: opt.railName,
          coordinate: opt.coordinate,
          mass: block.mass,
          cost: opt.cost,
          cumulativeMass: massAfter,
          cumulativeTorque: torqueAfter,
          loadMargin: limits.maxLoad - massAfter,
          torqueMargin: margin,
        });
        dfs(depth + 1, massAfter, torqueAfter, nextCost, nextMinMargin);
        steps.pop();
        used[i] = false;
      }
    }
  };

  dfs(0, 0, 0, { mantissa: 0n, scale: 0 }, Number.POSITIVE_INFINITY);

  if (best) return { feasible: true, plan: best };

  // 无可行方案：定位最深的可行已选前缀（其下一步即最早无法继续挂装的位置）。
  let depth = n - 1;
  while (depth >= 0 && bestPartial[depth] === null) depth--;
  const witness = depth >= 0 ? bestPartial[depth] : null;
  const witnessSteps = witness ? witness.steps : [];
  const usedBlocks = new Set(witnessSteps.map((s) => s.blockIndex));
  const baseMass = witness ? witness.finalMass : 0;
  const baseTorque = witness ? witness.finalTorque : 0;

  const violations: Violation[] = [];
  for (const block of blocks) {
    if (usedBlocks.has(block.index)) continue;
    for (const opt of block.options) {
      const massAfter = baseMass + block.mass;
      const torqueAfter = baseTorque + block.mass * opt.coordinate;
      const kinds: ViolationKind[] = [];
      if (massAfter > limits.maxLoad + EPS) kinds.push('load');
      if (torqueAfter < limits.minTorque - EPS) kinds.push('torque-low');
      if (torqueAfter > limits.maxTorque + EPS) kinds.push('torque-high');
      if (kinds.length > 0) {
        violations.push({
          blockIndex: block.index,
          blockName: block.name,
          optionIndex: opt.optionIndex,
          railId: opt.railId,
          railName: opt.railName,
          massAfter,
          torqueAfter,
          kinds,
        });
      }
    }
  }
  return { feasible: false, report: { witnessPrefix: witnessSteps, violations } };
}
