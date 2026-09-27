import { describe, expect, it } from 'vitest';
import { adjudicate, EPS } from './adjudicate';
import type { Scenario } from './types';

const rails = (...defs: [string, number][]): Scenario['rails'] =>
  defs.map(([name, coordinate], i) => ({ id: `rail-${i}`, name, coordinate }));

const block = (
  name: string,
  mass: number,
  options: [number, number][], // [railIndex, cost]
): Scenario['blocks'][number] => ({
  id: `blk-${name}`,
  name,
  mass,
  options: options.map(([railIndex, cost]) => ({ railId: `rail-${railIndex}`, cost })),
});

const limits = (maxLoad: number, minTorque: number, maxTorque: number): Scenario['limits'] => ({
  maxLoad,
  minTorque,
  maxTorque,
});

describe('adjudicate · 可行方案与决胜规则', () => {
  it('基本求解：前缀均满足约束，代价/序号稳定决胜', () => {
    // 两块等质量配重，左右对称；四套可行方案余量与代价全同，按录入序号取字典序最小。
    const outcome = adjudicate({
      rails: rails(['L', -1], ['R', 1]),
      blocks: [block('b1', 4, [[0, 1], [1, 1]]), block('b2', 4, [[0, 1], [1, 1]])],
      limits: limits(100, -5, 5),
    });
    expect(outcome.feasible).toBe(true);
    if (!outcome.feasible) return;
    expect(outcome.plan.steps.map((s) => [s.blockIndex, s.railName])).toEqual([
      [0, 'L'],
      [1, 'R'],
    ]);
    expect(outcome.plan.totalCost).toBeCloseTo(2);
    expect(outcome.plan.minTorqueMargin).toBeCloseTo(1);
    // 每个前缀状态同时满足载荷与力矩限制
    for (const s of outcome.plan.steps) {
      expect(s.cumulativeMass).toBeLessThanOrEqual(100 + EPS);
      expect(s.cumulativeTorque).toBeGreaterThanOrEqual(-5 - EPS);
      expect(s.cumulativeTorque).toBeLessThanOrEqual(5 + EPS);
    }
  });

  it('纳米级代价差不得被容差抹平：四块均须取零代价的 #2 位置', () => {
    // 2 条零力臂导轨，4 块单位质量配重；#1 代价 1e-10，#2 代价 0。
    // 各方案力矩余量完全相同，严格最小总代价为 0（旧实现以 EPS=1e-9
    // 比较代价，误把 4e-10 与 0 当并列，按序号错选了 #1）。
    const outcome = adjudicate({
      rails: rails(['Z1', 0], ['Z2', 0]),
      blocks: [
        block('b1', 1, [[0, 1e-10], [1, 0]]),
        block('b2', 1, [[0, 1e-10], [1, 0]]),
        block('b3', 1, [[0, 1e-10], [1, 0]]),
        block('b4', 1, [[0, 1e-10], [1, 0]]),
      ],
      limits: limits(4, -1, 1),
    });
    expect(outcome.feasible).toBe(true);
    if (!outcome.feasible) return;
    const plan = outcome.plan;
    // 完整方案：四块各恰用一次，且全部采用位置录入序号 #2（optionIndex 1）
    expect(plan.steps).toHaveLength(4);
    expect(new Set(plan.steps.map((s) => s.blockIndex))).toEqual(new Set([0, 1, 2, 3]));
    expect(plan.steps.map((s) => s.optionIndex)).toEqual([1, 1, 1, 1]);
    expect(plan.steps.map((s) => s.railName)).toEqual(['Z2', 'Z2', 'Z2', 'Z2']);
    // 总代价严格为 0（不用 toBeCloseTo：容差会把缺陷掩盖掉）
    expect(plan.totalCost).toBe(0);
    // 对照：错选方案本会产生 4e-10 的可避免成本
    expect(4 * 1e-10).toBeGreaterThan(plan.totalCost);
    // 力矩余量与边界：零力臂使力矩恒为 0，余量为 1；载荷恰好到上限
    expect(plan.minTorqueMargin).toBe(1);
    plan.steps.forEach((s) => {
      expect(s.cumulativeTorque).toBe(0);
      expect(s.cumulativeMass).toBeLessThanOrEqual(4 + EPS);
    });
    expect(plan.steps[3].cumulativeMass).toBe(4);
  });

  it('真正同代价（含双零代价）时仍按位置录入序号稳定决胜', () => {
    // 两个位置代价都为 0：不存在成本差，序号决胜应选 #1（optionIndex 0）。
    const outcome = adjudicate({
      rails: rails(['Z1', 0], ['Z2', 0]),
      blocks: [
        block('b1', 1, [[0, 0], [1, 0]]),
        block('b2', 1, [[0, 0], [1, 0]]),
        block('b3', 1, [[0, 0], [1, 0]]),
        block('b4', 1, [[0, 0], [1, 0]]),
      ],
      limits: limits(4, -1, 1),
    });
    expect(outcome.feasible).toBe(true);
    if (!outcome.feasible) return;
    expect(outcome.plan.totalCost).toBe(0);
    expect(outcome.plan.steps.map((s) => s.optionIndex)).toEqual([0, 0, 0, 0]);
  });

  it('十进制等价总代价须视为同成本并按稳定序号裁决（0.1+0.2 与 0.3+0）', () => {
    // 导轨 P(+1)、N(-1)、Z1/Z2(0)，四块单位质量，载荷上限 4，力矩区间 [-1,1]。
    // 满足最终力矩为 0 的方案恰为 b1@P+b2@N（0.1+0.2）与 b1@N+b2@P（0.3+0）：
    // 按录入十进制值总代价都为 0.3、力矩余量同为 0（中途必到 ±1 闭区间边界），
    // 必须落入序号决胜，取字典序较小的位置序号 0,0,0,0。
    // 浮点下 0.1+0.2=0.30000000000000004 ≠ 0.3，旧实现据此错选了 1,1,0,0。
    const outcome = adjudicate({
      rails: rails(['P', 1], ['N', -1], ['Z1', 0], ['Z2', 0]),
      blocks: [
        block('b1', 1, [
          [0, 0.1],
          [1, 0.3],
        ]),
        block('b2', 1, [
          [1, 0.2],
          [0, 0],
        ]),
        block('b3', 1, [
          [2, 0],
          [3, 0],
        ]),
        block('b4', 1, [
          [2, 0],
          [3, 0],
        ]),
      ],
      limits: limits(4, -1, 1),
    });
    expect(outcome.feasible).toBe(true);
    if (!outcome.feasible) return;
    const plan = outcome.plan;
    // 稳定结果：按录入序号 b1→b2→b3→b4，每块均取位置录入序号 #1。
    expect(plan.steps.map((s) => s.blockIndex)).toEqual([0, 1, 2, 3]);
    expect(plan.steps.map((s) => s.optionIndex)).toEqual([0, 0, 0, 0]);
    expect(plan.steps.map((s) => s.railName)).toEqual(['P', 'N', 'Z1', 'Z1']);
    // 总代价按十进制恰为 0.3（精确十进制求和转回，不用 toBeCloseTo）。
    expect(plan.totalCost).toBe(0.3);
    // 力矩余量相同：首个前缀在 +1 边界，余量为 0；最终力矩归零。
    expect(plan.minTorqueMargin).toBe(0);
    expect(plan.finalTorque).toBe(0);
    // 载荷边界：总质量恰好到上限 4；力矩边界：首步恰好 +1（闭区间允许）。
    expect(plan.finalMass).toBe(4);
    expect(plan.steps.map((s) => s.cumulativeMass)).toEqual([1, 2, 3, 4]);
    expect(plan.steps.map((s) => s.cumulativeTorque)).toEqual([1, 0, 0, 0]);
    plan.steps.forEach((s) => {
      expect(s.cumulativeMass).toBeLessThanOrEqual(4 + EPS);
      expect(s.cumulativeTorque).toBeGreaterThanOrEqual(-1 - EPS);
      expect(s.cumulativeTorque).toBeLessThanOrEqual(1 + EPS);
    });
  });

  it('十进制成本确有微小差额时仍严格优先较低成本（0.1+0.201 vs 0.3+0）', () => {
    // 与上例同构，但 b2@N 代价为 0.201：b1@P+b2@N=0.301 严格大于 b1@N+b2@P=0.3，
    // 差额仅 0.001，仍须选严格较低成本方案（位置序号 1,1），不得被“约等”误并列。
    const outcome = adjudicate({
      rails: rails(['P', 1], ['N', -1], ['Z1', 0], ['Z2', 0]),
      blocks: [
        block('b1', 1, [
          [0, 0.1],
          [1, 0.3],
        ]),
        block('b2', 1, [
          [1, 0.201],
          [0, 0],
        ]),
        block('b3', 1, [
          [2, 0],
          [3, 0],
        ]),
        block('b4', 1, [
          [2, 0],
          [3, 0],
        ]),
      ],
      limits: limits(4, -1, 1),
    });
    expect(outcome.feasible).toBe(true);
    if (!outcome.feasible) return;
    const byBlock = new Map(outcome.plan.steps.map((s) => [s.blockIndex, s]));
    expect([0, 1, 2, 3].map((k) => byBlock.get(k)?.optionIndex)).toEqual([1, 1, 0, 0]);
    expect([0, 1, 2, 3].map((k) => byBlock.get(k)?.railName)).toEqual(['N', 'P', 'Z1', 'Z1']);
    expect(outcome.plan.totalCost).toBe(0.3);
    expect(outcome.plan.minTorqueMargin).toBe(0);
    expect(outcome.plan.finalTorque).toBe(0);
    expect(outcome.plan.finalMass).toBe(4);
  });

  it('力矩余量最大优先于总代价最小', () => {
    // 便宜方案（代价 2）余量仅 1；居中方案（代价 20）余量 5，必须选后者。
    const outcome = adjudicate({
      rails: rails(['L', -2], ['M', 0], ['R', 2]),
      blocks: [block('b1', 2, [[1, 10], [2, 1]]), block('b2', 2, [[0, 1], [1, 10]])],
      limits: limits(100, -5, 5),
    });
    expect(outcome.feasible).toBe(true);
    if (!outcome.feasible) return;
    expect(outcome.plan.minTorqueMargin).toBeCloseTo(5);
    expect(outcome.plan.totalCost).toBeCloseTo(20);
    expect(outcome.plan.steps.map((s) => s.railName)).toEqual(['M', 'M']);
  });

  it('余量并列时取总代价最小，再按挂装顺序与位置录入序号决胜', () => {
    // 两条零力臂导轨 M1/M2：余量 5 的方案中，b1@M2 + b2@M1 代价 8 最小。
    const outcome = adjudicate({
      rails: rails(['L', -2], ['M1', 0], ['M2', 0], ['R', 2]),
      blocks: [
        block('b1', 2, [[1, 8], [2, 3], [3, 1]]),
        block('b2', 2, [[1, 5], [2, 6], [0, 1]]),
      ],
      limits: limits(100, -5, 5),
    });
    expect(outcome.feasible).toBe(true);
    if (!outcome.feasible) return;
    expect(outcome.plan.minTorqueMargin).toBeCloseTo(5);
    expect(outcome.plan.totalCost).toBeCloseTo(8);
    expect(outcome.plan.steps.map((s) => [s.blockIndex, s.railName])).toEqual([
      [0, 'M2'],
      [1, 'M1'],
    ]);
  });

  it('联合确定位置与次序：不得先选最终位置再事后排序', () => {
    // b4 挂 L（-6）时最终合力矩可为 0，但任何挂装次序都会在中途越界；
    // 只有 b4 挂 H（-3）且 b3 挂 L 并交错挂装才全程安全，且代价更高（9）。
    const outcome = adjudicate({
      rails: rails(['L', -1], ['H', -0.5], ['R', 1]),
      blocks: [
        block('b1', 2, [[2, 1]]),
        block('b2', 2, [[2, 1]]),
        block('b3', 2, [[2, 1], [0, 1]]),
        block('b4', 6, [[0, 1], [1, 9]]),
      ],
      limits: limits(100, -3, 3),
    });
    expect(outcome.feasible).toBe(true);
    if (!outcome.feasible) return;
    expect(outcome.plan.steps.map((s) => [s.blockIndex, s.railName])).toEqual([
      [0, 'R'],
      [2, 'L'],
      [1, 'R'],
      [3, 'H'],
    ]);
    expect(outcome.plan.totalCost).toBeCloseTo(12);
    expect(outcome.plan.minTorqueMargin).toBeCloseTo(1);
    for (const s of outcome.plan.steps) {
      expect(s.cumulativeTorque).toBeGreaterThanOrEqual(-3 - EPS);
      expect(s.cumulativeTorque).toBeLessThanOrEqual(3 + EPS);
    }
  });

  it('多块场景：每块恰用一次且结果确定（可重复）', () => {
    const scenario: Scenario = {
      rails: rails(['L2', -2], ['L1', -1], ['C', 0], ['R1', 1], ['R2', 2]),
      blocks: [
        block('b1', 20, [[1, 2], [3, 2]]),
        block('b2', 15, [[0, 3], [4, 3], [2, 5]]),
        block('b3', 25, [[1, 4], [4, 4]]),
        block('b4', 10, [[2, 1], [3, 2]]),
        block('b5', 30, [[0, 2], [3, 3], [4, 4]]),
      ],
      limits: limits(150, -100, 100),
    };
    const first = adjudicate(scenario);
    const second = adjudicate(scenario);
    expect(first).toEqual(second);
    expect(first.feasible).toBe(true);
    if (!first.feasible) return;
    expect(first.plan.steps).toHaveLength(5);
    expect(new Set(first.plan.steps.map((s) => s.blockIndex)).size).toBe(5);
    for (const s of first.plan.steps) {
      expect(s.cumulativeMass).toBeLessThanOrEqual(150 + EPS);
      expect(Math.abs(s.cumulativeTorque)).toBeLessThanOrEqual(100 + EPS);
      expect(s.loadMargin).toBeCloseTo(150 - s.cumulativeMass);
    }
  });
});

describe('adjudicate · 无可行方案的诊断', () => {
  it('第一步即不可挂：已选前缀为空，逐一列出触发的力矩限制', () => {
    const outcome = adjudicate({
      rails: rails(['L', -1], ['R', 1]),
      blocks: [block('b1', 3, [[0, 1], [1, 1]]), block('b2', 3, [[0, 1], [1, 1]])],
      limits: limits(100, -2, 2),
    });
    expect(outcome.feasible).toBe(false);
    if (outcome.feasible) return;
    expect(outcome.report.witnessPrefix).toHaveLength(0);
    expect(outcome.report.violations).toHaveLength(4);
    const kinds = new Map(outcome.report.violations.map((v) => [`${v.blockIndex}:${v.railName}`, v.kinds]));
    expect(kinds.get('0:L')).toEqual(['torque-low']);
    expect(kinds.get('0:R')).toEqual(['torque-high']);
    expect(kinds.get('1:L')).toEqual(['torque-low']);
    expect(kinds.get('1:R')).toEqual(['torque-high']);
  });

  it('最深前缀止步于载荷限制', () => {
    const outcome = adjudicate({
      rails: rails(['M', 0]),
      blocks: [block('b1', 3, [[0, 1]]), block('b2', 3, [[0, 1]]), block('b3', 3, [[0, 1]])],
      limits: limits(5, -10, 10),
    });
    expect(outcome.feasible).toBe(false);
    if (outcome.feasible) return;
    expect(outcome.report.witnessPrefix).toHaveLength(1);
    expect(outcome.report.witnessPrefix[0].blockIndex).toBe(0);
    expect(outcome.report.violations).toHaveLength(2);
    for (const v of outcome.report.violations) {
      expect(v.kinds).toEqual(['load']);
      expect(v.massAfter).toBeCloseTo(6);
    }
  });

  it('最深前缀按裁决优先级选取，并列选择同时触发载荷与力矩限制', () => {
    // 深度 1 的三个可行前缀余量分别为 2/1/0，须选余量最大的 b1。
    const outcome = adjudicate({
      rails: rails(['R', 1]),
      blocks: [block('b1', 3, [[0, 1]]), block('b2', 4, [[0, 1]]), block('b3', 5, [[0, 1]])],
      limits: limits(6, -5, 5),
    });
    expect(outcome.feasible).toBe(false);
    if (outcome.feasible) return;
    expect(outcome.report.witnessPrefix).toHaveLength(1);
    expect(outcome.report.witnessPrefix[0].blockIndex).toBe(0);
    expect(outcome.report.witnessPrefix[0].cumulativeTorque).toBeCloseTo(3);
    expect(outcome.report.violations).toHaveLength(2);
    for (const v of outcome.report.violations) {
      expect(v.kinds).toEqual(['load', 'torque-high']);
    }
  });
});
