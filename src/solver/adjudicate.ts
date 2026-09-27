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
 * 数值比较容差：仅用于力矩余量决胜与分支限界（余量是优化目标而非约束）。
 * 注意：载荷/力矩约束判定与安装代价比较均不使用此容差——它们是逐位有意义的
 * 十进制录入值，改以精确十进制（大整数尾数）严格判定，见下方 Decimal。
 */
export const EPS = 1e-9;

/**
 * 录入十进制值的精确表示。
 *
 * 质量、力臂、载荷/力矩限制与安装代价都来自文本录入的十进制值（如 0.1、0.3），
 * 而浮点二进制无法精确表示这些值：0.1 + 0.2 = 0.30000000000000004 ≠ 0.3。
 * 因此裁决内部以 (整数尾数, 小数位数) 精确保存录入值，并以未缩放大整数求和/比较：
 *
 * - 载荷与力矩约束按录入的十进制值严格判定：任何真实越界（哪怕仅 1e-10，
 *   如力矩 1.0000000001 对上限 1）都判不可行；恰好等于边界（闭区间）仍属可行。
 * - 安装代价按录入的十进制值比较：用户按十进制录入的同代价方案（0.1+0.2 与
 *   0.3+0）真正并列；真实的成本差（哪怕仅 1e-10）尾数不同，仍严格偏向较低成本。
 */
interface Decimal {
  /** 去掉小数点后的整数尾数（带符号），如 0.10 → 1、-1.5 → -15。 */
  mantissa: bigint;
  /** 录入值的小数位数，如 "0.10" → 2。 */
  scale: number;
}

const decimalCache = new Map<number, Decimal>();

/**
 * 把数值化后的录入值还原为精确十进制。parseDraft 由文本经 Number() 得到数值，
 * Number.toString 对合法录入产生其最简十进制（0.1→"0.1"、1e-10→"1e-10"），
 * 由此恢复与用户录入逐位等价的尾数；力臂与力矩限制可负，符号并入尾数。
 * 录入规模与块数（≤7）都很小，尾数不会越界。
 */
function toDecimal(value: number): Decimal {
  const cached = decimalCache.get(value);
  if (cached) return cached;
  let s = String(value);
  let negative = false;
  if (s.startsWith('-')) {
    negative = true;
    s = s.slice(1);
  }
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
  const d = { mantissa: negative ? -mantissa : mantissa, scale };
  decimalCache.set(value, d);
  return d;
}

/** 精确十进制总和：各加数按最大小数位放大为整数后相加。 */
function addDecimal(a: Decimal, b: Decimal): Decimal {
  const scale = Math.max(a.scale, b.scale);
  const mantissa = a.mantissa * 10n ** BigInt(scale - a.scale) + b.mantissa * 10n ** BigInt(scale - b.scale);
  return { mantissa, scale };
}

/** 精确十进制乘积（如 质量 × 力臂 = 力矩贡献）：尾数相乘、小数位相加。 */
function multiplyDecimal(a: Decimal, b: Decimal): Decimal {
  return { mantissa: a.mantissa * b.mantissa, scale: a.scale + b.scale };
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
  /** 本块挂入该位置的力矩贡献（质量 × 力臂）的精确十进制表示。 */
  torqueDecimal: Decimal;
}

interface FlatBlock {
  index: number;
  name: string;
  mass: number;
  /** 录入质量的精确十进制表示（载荷约束以此判定）。 */
  massDecimal: Decimal;
  options: FlatOption[];
}

/** 把精确十进制总和转回数值用于结果展示（本身仍是最接近该十进制值的浮点）。 */
function decimalToNumber(d: Decimal): number {
  if (d.scale === 0) return Number(d.mantissa);
  const negative = d.mantissa < 0n;
  const digits = (negative ? -d.mantissa : d.mantissa).toString().padStart(d.scale + 1, '0');
  return Number(`${negative ? '-' : ''}${digits.slice(0, -d.scale)}.${digits.slice(-d.scale)}`);
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

/** 搜索内部使用的方案：在对外 Plan 之上附带精确十进制的总代价、已挂质量与合力矩。 */
interface SearchPlan extends Plan {
  costExact: Decimal;
  massExact: Decimal;
  torqueExact: Decimal;
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
 * 搜索按挂装顺序逐步进行，每一个前缀状态都按录入的十进制值精确校验总载荷与
 * 力矩闭区间（严格越界哪怕仅 1e-10 也判不可行，恰好落在边界上仍属可行），
 * 因此绝不出现“先定最终位置再事后排序”的情况；力矩余量沿前缀单调不增、
 * 总代价单调不减（代价非负），据此对当前最优解做分支限界。
 * 总代价、已挂质量与合力矩均以精确十进制（未缩放大整数）累加，整数加法满足
 * 结合/交换律，故随挂装次序递增累加与规范求和逐位相同。
 */
export function adjudicate(scenario: Scenario): AdjudicationOutcome {
  const railById = new Map(scenario.rails.map((r) => [r.id, r]));
  const blocks: FlatBlock[] = scenario.blocks.map((b, i) => {
    const massDecimal = toDecimal(b.mass);
    return {
      index: i,
      name: b.name,
      mass: b.mass,
      massDecimal,
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
          torqueDecimal: multiplyDecimal(massDecimal, toDecimal(rail.coordinate)),
        };
      }),
    };
  });
  const n = blocks.length;
  const limits = scenario.limits;
  /** 载荷/力矩限制的精确十进制表示：约束按录入的十进制值严格判定，不用容差。 */
  const maxLoadExact = toDecimal(limits.maxLoad);
  const minTorqueExact = toDecimal(limits.minTorque);
  const maxTorqueExact = toDecimal(limits.maxTorque);
  const zeroExact: Decimal = { mantissa: 0n, scale: 0 };

  const used = new Array<boolean>(n).fill(false);
  const steps: StepRecord[] = [];
  let best: SearchPlan | null = null;
  /** 每个深度上按裁决优先级最优的可行前缀（用于无可行方案时的诊断）。 */
  const bestPartial: (SearchPlan | null)[] = new Array(n + 1).fill(null);

  const snapshot = (costExact: Decimal, massExact: Decimal, torqueExact: Decimal, minTorqueMargin: number): SearchPlan => ({
    steps: steps.map((s) => ({ ...s })),
    totalCost: decimalToNumber(costExact),
    costExact,
    massExact,
    torqueExact,
    minTorqueMargin,
    finalMass: decimalToNumber(massExact),
    finalTorque: decimalToNumber(torqueExact),
  });

  const dfs = (depth: number, mass: Decimal, torque: Decimal, totalCost: Decimal, minMargin: number): void => {
    const current = snapshot(totalCost, mass, torque, minMargin);
    if (isBetter(current, bestPartial[depth])) bestPartial[depth] = current;
    if (depth === n) {
      if (isBetter(current, best)) best = current;
      return;
    }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      const block = blocks[i];
      for (const opt of block.options) {
        const massAfter = addDecimal(mass, block.massDecimal);
        if (compareDecimal(massAfter, maxLoadExact) > 0) continue;
        const torqueAfter = addDecimal(torque, opt.torqueDecimal);
        if (compareDecimal(torqueAfter, minTorqueExact) < 0 || compareDecimal(torqueAfter, maxTorqueExact) > 0) {
          continue;
        }
        const massAfterNum = decimalToNumber(massAfter);
        const torqueAfterNum = decimalToNumber(torqueAfter);
        const margin = torqueMarginOf(torqueAfterNum, limits);
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
          cumulativeMass: massAfterNum,
          cumulativeTorque: torqueAfterNum,
          loadMargin: limits.maxLoad - massAfterNum,
          torqueMargin: margin,
        });
        dfs(depth + 1, massAfter, torqueAfter, nextCost, nextMinMargin);
        steps.pop();
        used[i] = false;
      }
    }
  };

  dfs(0, zeroExact, zeroExact, zeroExact, Number.POSITIVE_INFINITY);

  if (best) return { feasible: true, plan: best };

  // 无可行方案：定位最深的可行已选前缀（其下一步即最早无法继续挂装的位置）。
  let depth = n - 1;
  while (depth >= 0 && bestPartial[depth] === null) depth--;
  const witness = depth >= 0 ? bestPartial[depth] : null;
  const witnessSteps = witness ? witness.steps : [];
  const usedBlocks = new Set(witnessSteps.map((s) => s.blockIndex));
  const baseMass = witness ? witness.massExact : zeroExact;
  const baseTorque = witness ? witness.torqueExact : zeroExact;

  const violations: Violation[] = [];
  for (const block of blocks) {
    if (usedBlocks.has(block.index)) continue;
    for (const opt of block.options) {
      const massAfter = addDecimal(baseMass, block.massDecimal);
      const torqueAfter = addDecimal(baseTorque, opt.torqueDecimal);
      const kinds: ViolationKind[] = [];
      if (compareDecimal(massAfter, maxLoadExact) > 0) kinds.push('load');
      if (compareDecimal(torqueAfter, minTorqueExact) < 0) kinds.push('torque-low');
      if (compareDecimal(torqueAfter, maxTorqueExact) > 0) kinds.push('torque-high');
      if (kinds.length > 0) {
        violations.push({
          blockIndex: block.index,
          blockName: block.name,
          optionIndex: opt.optionIndex,
          railId: opt.railId,
          railName: opt.railName,
          massAfter: decimalToNumber(massAfter),
          torqueAfter: decimalToNumber(torqueAfter),
          kinds,
        });
      }
    }
  }
  return { feasible: false, report: { witnessPrefix: witnessSteps, violations } };
}
