/**
 * 一次性冒烟脚本（verify 服务）：
 *  1. 对裁决业务模块跑确定性用例（可行 / 不可行）；
 *  2. 探测已启动页面的健康端点 /healthz；
 *  3. 探测首页可访问。
 * 全部通过以退出码 0 结束，否则退出码 1。
 */
import { adjudicate } from '../src/solver/adjudicate';
import type { Scenario } from '../src/solver/types';

const base = `http://${process.env.WEB_HOST ?? 'web'}:${process.env.WEB_PORT ?? '8080'}`;

let failures = 0;
const check = (cond: boolean, msg: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
};

// ---------- 1. 裁决业务模块冒烟 ----------

// 可行场景：余量 5 的方案中 b1@M2 + b2@M1 总代价 8 最小，次序按录入序号决胜。
const feasibleScenario: Scenario = {
  rails: [
    { id: 'L', name: 'L', coordinate: -2 },
    { id: 'M1', name: 'M1', coordinate: 0 },
    { id: 'M2', name: 'M2', coordinate: 0 },
    { id: 'R', name: 'R', coordinate: 2 },
  ],
  blocks: [
    { id: 'b1', name: 'b1', mass: 2, options: [{ railId: 'M1', cost: 8 }, { railId: 'M2', cost: 3 }, { railId: 'R', cost: 1 }] },
    { id: 'b2', name: 'b2', mass: 2, options: [{ railId: 'M1', cost: 5 }, { railId: 'M2', cost: 6 }, { railId: 'L', cost: 1 }] },
  ],
  limits: { maxLoad: 100, minTorque: -5, maxTorque: 5 },
};

const r1 = adjudicate(feasibleScenario);
check(r1.feasible, '裁决模块：可行场景应判定为可行');
if (r1.feasible) {
  check(r1.plan.steps.length === 2, '裁决模块：方案应覆盖全部配重（每块恰用一次）');
  check(
    r1.plan.steps.every((s) => Math.abs(s.cumulativeTorque) <= 5 + 1e-9 && s.cumulativeMass <= 100 + 1e-9),
    '裁决模块：每个前缀状态均满足载荷与力矩限制',
  );
  check(Math.abs(r1.plan.totalCost - 8) < 1e-9, `裁决模块：总安装代价应为 8（实际 ${r1.plan.totalCost}）`);
  check(Math.abs(r1.plan.minTorqueMargin - 5) < 1e-9, `裁决模块：力矩余量应为 5（实际 ${r1.plan.minTorqueMargin}）`);
  check(
    r1.plan.steps[0].railId === 'M2' && r1.plan.steps[1].railId === 'M1',
    '裁决模块：挂装位置与次序应符合决胜规则（b1@M2 → b2@M1）',
  );
}

// 纳米级代价差场景：#1 代价 1e-10、#2 代价 0；力矩余量全同，
// 严格最低总代价为 0，四块均须采用位置录入序号 #2（optionIndex 1）。
const nanoCostScenario: Scenario = {
  rails: [
    { id: 'Z1', name: 'Z1', coordinate: 0 },
    { id: 'Z2', name: 'Z2', coordinate: 0 },
  ],
  blocks: [1, 2, 3, 4].map((k) => ({
    id: `b${k}`,
    name: `b${k}`,
    mass: 1,
    options: [
      { railId: 'Z1', cost: 1e-10 },
      { railId: 'Z2', cost: 0 },
    ],
  })),
  limits: { maxLoad: 4, minTorque: -1, maxTorque: 1 },
};

const r0 = adjudicate(nanoCostScenario);
check(r0.feasible, '裁决模块：纳米代价场景应判定为可行');
if (r0.feasible) {
  const p = r0.plan;
  check(p.steps.length === 4, '纳米代价：完整方案应覆盖四块配重');
  check(
    p.steps.every((s) => s.optionIndex === 1 && s.railId === 'Z2'),
    '纳米代价：四块均须采用零代价的位置 #2（Z2）',
  );
  check(p.totalCost === 0, `纳米代价：总代价须严格为 0（实际 ${p.totalCost}）`);
}

// 十进制等价代价场景：P(+1)、N(-1)、Z1/Z2(0)，四块单位质量，
// 载荷上限 4、力矩区间 [-1,1]。满足最终力矩的方案 b1@P+b2@N（0.1+0.2）
// 与 b1@N+b2@P（0.3+0）按录入十进制值同为 0.3，余量同为 0（首步贴 ±1 闭边界），
// 须按位置录入序号决胜为 0,0,0,0——浮点 0.1+0.2=0.30000000000000004 不得制造成本差。
const decimalTieScenario: Scenario = {
  rails: [
    { id: 'P', name: 'P', coordinate: 1 },
    { id: 'N', name: 'N', coordinate: -1 },
    { id: 'Z1', name: 'Z1', coordinate: 0 },
    { id: 'Z2', name: 'Z2', coordinate: 0 },
  ],
  blocks: [
    { id: 'b1', name: 'b1', mass: 1, options: [{ railId: 'P', cost: 0.1 }, { railId: 'N', cost: 0.3 }] },
    { id: 'b2', name: 'b2', mass: 1, options: [{ railId: 'N', cost: 0.2 }, { railId: 'P', cost: 0 }] },
    { id: 'b3', name: 'b3', mass: 1, options: [{ railId: 'Z1', cost: 0 }, { railId: 'Z2', cost: 0 }] },
    { id: 'b4', name: 'b4', mass: 1, options: [{ railId: 'Z1', cost: 0 }, { railId: 'Z2', cost: 0 }] },
  ],
  limits: { maxLoad: 4, minTorque: -1, maxTorque: 1 },
};

const rt = adjudicate(decimalTieScenario);
check(rt.feasible, '裁决模块：十进制等价代价场景应判定为可行');
if (rt.feasible) {
  const byBlock = new Map(rt.plan.steps.map((s) => [Number(s.blockName.slice(1)) - 1, s]));
  check(
    [0, 1, 2, 3].map((k) => byBlock.get(k)?.optionIndex).join(',') === '0,0,0,0',
    '十进制等价：同成本须按稳定序号裁决为 0,0,0,0（实际 ' +
      [0, 1, 2, 3].map((k) => byBlock.get(k)?.optionIndex).join(',') +
      '）',
  );
  check(
    [0, 1].map((k) => byBlock.get(k)?.railId).join('+') === 'P+N',
    '十进制等价：方案应为 b1@P + b2@N（实际 ' + [0, 1].map((k) => byBlock.get(k)?.railId).join('+') + '）',
  );
  check(rt.plan.totalCost === 0.3, `十进制等价：总代价应为 0.3（实际 ${rt.plan.totalCost}）`);
  check(rt.plan.minTorqueMargin === 0, '十进制等价：力矩余量应为 0（首步贴闭区间边界）');
  check(rt.plan.finalMass === 4 && rt.plan.finalTorque === 0, '十进制等价：载荷恰好 4（上限）、最终力矩归零');
  check(
    rt.plan.steps.every((s) => Math.abs(s.cumulativeTorque) <= 1 + 1e-9 && s.cumulativeMass <= 4 + 1e-9),
    '十进制等价：各前缀满足载荷与力矩闭区间（含 ±1/4 边界）',
  );
}

// 真实不等十进制成本：b2@N 改为 0.201，则 0.1+0.201=0.301 严格大于 0.3，
// 差额仅 0.001 也必须选 b1@N+b2@P（序号 1,1），序号决胜不得覆盖真实成本差。
const decimalDiffScenario: Scenario = {
  ...decimalTieScenario,
  blocks: [
    { id: 'b1', name: 'b1', mass: 1, options: [{ railId: 'P', cost: 0.1 }, { railId: 'N', cost: 0.3 }] },
    { id: 'b2', name: 'b2', mass: 1, options: [{ railId: 'N', cost: 0.201 }, { railId: 'P', cost: 0 }] },
    { id: 'b3', name: 'b3', mass: 1, options: [{ railId: 'Z1', cost: 0 }, { railId: 'Z2', cost: 0 }] },
    { id: 'b4', name: 'b4', mass: 1, options: [{ railId: 'Z1', cost: 0 }, { railId: 'Z2', cost: 0 }] },
  ],
};

const rd = adjudicate(decimalDiffScenario);
check(rd.feasible, '裁决模块：真实不等十进制成本场景应判定为可行');
if (rd.feasible) {
  const byBlock = new Map(rd.plan.steps.map((s) => [Number(s.blockName.slice(1)) - 1, s]));
  check(
    [0, 1, 2, 3].map((k) => byBlock.get(k)?.optionIndex).join(',') === '1,1,0,0',
    '十进制不等：须严格取较低成本方案 1,1,0,0（实际 ' +
      [0, 1, 2, 3].map((k) => byBlock.get(k)?.optionIndex).join(',') +
      '）',
  );
  check(rd.plan.totalCost === 0.3, `十进制不等：总代价应为严格较低的 0.3（实际 ${rd.plan.totalCost}）`);
  check(rd.plan.finalMass === 4 && rd.plan.finalTorque === 0, '十进制不等：载荷与力矩边界保持成立');
}

// 不可行场景：深度 1 即止步，最深前缀为 b1@R（余量最大），剩余选择同时触发载荷与力矩限制。
const infeasibleScenario: Scenario = {
  rails: [{ id: 'R', name: 'R', coordinate: 1 }],
  blocks: [
    { id: 'b1', name: 'b1', mass: 3, options: [{ railId: 'R', cost: 1 }] },
    { id: 'b2', name: 'b2', mass: 4, options: [{ railId: 'R', cost: 1 }] },
    { id: 'b3', name: 'b3', mass: 5, options: [{ railId: 'R', cost: 1 }] },
  ],
  limits: { maxLoad: 6, minTorque: -5, maxTorque: 5 },
};

const r2 = adjudicate(infeasibleScenario);
check(!r2.feasible, '裁决模块：不可行场景应判定为不可行');
if (!r2.feasible) {
  check(r2.report.witnessPrefix.length === 1, '裁决模块：应给出最深可行已选前缀（长度 1）');
  check(
    r2.report.witnessPrefix[0]?.blockIndex === 0,
    '裁决模块：已选前缀应取余量最大的 b1',
  );
  check(
    r2.report.violations.length === 2 &&
      r2.report.violations.every((v) => v.kinds.includes('load') && v.kinds.includes('torque-high')),
    '裁决模块：应列出剩余选择触发的载荷/力矩限制',
  );
}

// ---------- 2. 已启动页面健康端点冒烟 ----------

const deadline = Date.now() + 60_000;
let health: { status?: string } | null = null;
while (Date.now() < deadline) {
  try {
    const res = await fetch(`${base}/healthz`);
    if (res.ok) {
      health = (await res.json()) as { status?: string };
      break;
    }
  } catch {
    // 页面尚未就绪，继续等待
  }
  await new Promise((r) => setTimeout(r, 1000));
}
check(health !== null && health.status === 'ok', `健康端点 ${base}/healthz 应返回 status=ok`);

// ---------- 3. 首页可访问 ----------

try {
  const res = await fetch(`${base}/`);
  const html = await res.text();
  check(res.ok && html.includes('id="root"'), `首页 ${base}/ 应返回包含挂载点的 HTML`);
} catch {
  check(false, `首页 ${base}/ 请求失败`);
}

if (failures > 0) {
  console.error(`\nsmoke: ${failures} 项未通过`);
  process.exit(1);
}
console.log('\nsmoke: 全部通过');
