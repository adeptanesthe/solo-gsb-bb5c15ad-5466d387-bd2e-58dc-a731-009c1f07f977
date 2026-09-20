const assert = require('node:assert/strict');
const {
  computeEffective,
  evaluateKey,
  parseSequence,
  generateRegressionSuite,
  minimumSetCover,
  conflictGoalId,
  previewSandbox,
  replayTimeline,
} = require('../src/engine');

let passed = 0;
const test = (name, fn) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

// 构造可控数据
const state = {
  contexts: [
    { id: 'root', parentId: null, name: 'Root' },
    { id: 'a', parentId: 'root', name: 'A' },
    { id: 'b', parentId: 'a', name: 'B' },
    { id: 'sibling', parentId: 'root', name: 'Sibling' },
  ],
  commands: [
    { id: 'c1', contextId: 'root', name: 'root-x', sequenceTokens: ['x'], sequenceLabel: 'X', description: '' },
    { id: 'c2', contextId: 'root', name: 'root-g', sequenceTokens: ['g'], sequenceLabel: 'G', description: '' },
    { id: 'c3', contextId: 'root', name: 'root-gd', sequenceTokens: ['g', 'd'], sequenceLabel: 'G D', description: '' },
    { id: 'c4', contextId: 'a', name: 'a-x', sequenceTokens: ['x'], sequenceLabel: 'X', description: '' },
    { id: 'c5', contextId: 'a', name: 'a-y1', sequenceTokens: ['y'], sequenceLabel: 'Y', description: '' },
    { id: 'c6', contextId: 'a', name: 'a-y2', sequenceTokens: ['y'], sequenceLabel: 'Y', description: '' },
    { id: 'c7', contextId: 'b', name: 'b-g', sequenceTokens: ['g'], sequenceLabel: 'G', description: '' },
    { id: 'c8', contextId: 'sibling', name: 'sib-k', sequenceTokens: ['k'], sequenceLabel: 'K', description: '' },
  ],
};

test('序列解析：空格/逗号分隔，1~3 次', () => {
  assert.deepEqual(parseSequence('g l').tokens, ['g', 'l']);
  assert.deepEqual(parseSequence('Ctrl+K, x').tokens, ['ctrl+k', 'x']);
  assert.ok(parseSequence('a b c d').ok === false);
  assert.ok(parseSequence('').ok === false);
  assert.ok(parseSequence('ctrl+alt').ok === false); // 没有主键
  assert.equal(parseSequence('shift+k').tokens[0], 'shift+k');
});

test('最近祖先：B 的 X 被 A 覆盖，root X 标记 shadowed', () => {
  const eff = computeEffective(state, 'b');
  const active = eff.entries.filter((e) => e.state !== 'shadowed');
  assert.ok(active.some((e) => e.commandId === 'c4')); // a-x 生效
  assert.ok(!active.some((e) => e.commandId === 'c1')); // root-x 不生效
  const shadow = eff.entries.find((e) => e.commandId === 'c1');
  assert.equal(shadow.state, 'shadowed');
});

test('同层相同序列：duplicate 冲突且双方都在生效列表', () => {
  const eff = computeEffective(state, 'a');
  const c5 = eff.entries.find((e) => e.commandId === 'c5');
  const c6 = eff.entries.find((e) => e.commandId === 'c6');
  assert.equal(c5.state, 'duplicate');
  assert.equal(c6.state, 'duplicate');
  assert.ok(eff.conflicts.some((c) => c.type === 'duplicate' && c.parties.length === 2));
});

test('前缀冲突：根的 G 与 G D 双方标记，且包含跨层情况', () => {
  const effRoot = computeEffective(state, 'root');
  assert.ok(effRoot.conflicts.some((c) => c.type === 'prefix'));
  const g = effRoot.entries.find((e) => e.commandId === 'c2');
  const gd = effRoot.entries.find((e) => e.commandId === 'c3');
  assert.equal(g.prefix, 'prefix');
  assert.equal(gd.prefix, 'extension');

  // B 层：B 的 G（c7）与 root 的 G D（c3）构成跨层前缀冲突
  const effB = computeEffective(state, 'b');
  assert.ok(
    effB.conflicts.some(
      (c) => c.type === 'prefix' && c.parties.some((p) => p.commandId === 'c7') && c.parties.some((p) => p.commandId === 'c3'),
    ),
  );
  // root 的 G（c2）在 B 下被覆盖，不参与前缀冲突
  assert.ok(!effB.conflicts.some((c) => c.parties.some((p) => p.commandId === 'c2')));
});

test('生效绑定只包含当前上下文链上的命令，兄弟上下文不串入', () => {
  const eff = computeEffective(state, 'b');
  assert.ok(!eff.entries.some((e) => e.commandId === 'c8'));
});

test('逐键模拟：idle → waiting → triggered', () => {
  let r = evaluateKey(state, 'root', []);
  assert.equal(r.status, 'idle');
  r = evaluateKey(state, 'root', ['g']);
  assert.equal(r.status, 'triggered'); // G 自身是命令
  assert.ok(r.candidates.length >= 1); // 同时是 G D 的前缀
  assert.ok(r.candidates.some((c) => c.sequenceLabel === 'G D'));
  r = evaluateKey(state, 'root', ['g', 'd']);
  assert.equal(r.status, 'triggered');
  assert.equal(r.triggered[0].commandId, 'c3');
});

test('逐键模拟：等待态与无匹配', () => {
  // A 层没有 G 单独命令，只有 root 的 G（在 A 下仍生效）。构造更独立的场景：
  const st2 = {
    contexts: [{ id: 'r', parentId: null, name: 'R' }],
    commands: [{ id: 'z1', contextId: 'r', name: 'zab', sequenceTokens: ['z', 'a', 'b'], sequenceLabel: 'Z A B', description: '' }],
  };
  assert.equal(evaluateKey(st2, 'r', ['z']).status, 'waiting');
  assert.equal(evaluateKey(st2, 'r', ['z', 'a']).status, 'waiting');
  assert.equal(evaluateKey(st2, 'r', ['z', 'a', 'b']).status, 'triggered');
  assert.equal(evaluateKey(st2, 'r', ['x']).status, 'no-match');
  assert.equal(evaluateKey(st2, 'r', ['z', 'q']).status, 'no-match');
});

test('逐键模拟：duplicate 命中时 triggered 含双方', () => {
  const r = evaluateKey(state, 'a', ['y']);
  assert.equal(r.status, 'triggered');
  const ids = r.triggered.map((t) => t.commandId).sort();
  assert.deepEqual(ids, ['c5', 'c6']);
});

// ---------- 带超时阈值的时序回放 ----------
// 复用顶部 state：root 有 G（c2）与 G D（c3）；a 层 Y/Y 同层重复（c5/c6）
const replay = (contextId, presses, timeoutMs = 500, base = state) =>
  replayTimeline(base, contextId, { timeoutMs, presses });

const replayStatuses = (r) => r.events.map((e) => (e.type === 'timeout' ? `timeout@${e.at}:${e.status}` : `${e.press}@${e.at}:${e.status}`));

test('时序回放：阈值内续键触发长序列，短序列保持待定不触发', () => {
  const r = replay('root', [
    { press: 'g', at: 0 },
    { press: 'd', at: 200 },
  ]);
  assert.deepEqual(replayStatuses(r), ['G@0:pending', 'D@200:triggered']);
  assert.equal(r.events[0].pending.deadlineAt, 500);
  assert.ok(r.events[0].candidates.some((c) => c.sequenceLabel === 'G D'));
  assert.equal(r.triggers.length, 1);
  assert.equal(r.triggers[0].trigger, 'pending-continue');
  assert.equal(r.triggers[0].triggered[0].commandId, 'c3');
  assert.equal(r.finalStatus, 'triggered');
  assert.equal(r.pendingAtEnd, false);
});

test('时序回放：超时（间隔 > 阈值）触发短序列，下一按键重新起算', () => {
  const r = replay('root', [
    { press: 'g', at: 0 },
    { press: 'd', at: 700 },
  ]);
  assert.deepEqual(replayStatuses(r), ['G@0:pending', 'timeout@500:triggered', 'D@700:no-match']);
  // 超时事件触发短序列 c2
  const timeoutEv = r.events.find((e) => e.type === 'timeout');
  assert.equal(timeoutEv.bufferLabel, 'G');
  assert.equal(timeoutEv.triggered[0].commandId, 'c2');
  assert.deepEqual(
    r.triggers.map((t) => [t.at, t.trigger, t.triggered[0].commandId]),
    [[500, 'timeout', 'c2']],
  );
  assert.equal(r.finalStatus, 'no-match');
});

test('时序回放：间隔恰等于阈值时先算超时（边界规则）', () => {
  const r = replay('root', [
    { press: 'g', at: 100 },
    { press: 'd', at: 600 },
  ]);
  assert.deepEqual(replayStatuses(r), ['G@100:pending', 'timeout@600:triggered', 'D@600:no-match']);
  assert.equal(r.triggers[0].at, 600);
});

test('时序回放：无匹配后从当前按键重新起算，不吞键', () => {
  // z 无匹配，随后 g 进入待定；模拟真实「z g [超时]」
  const r = replay('root', [
    { press: 'z', at: 0 },
    { press: 'g', at: 100 },
  ]);
  assert.deepEqual(replayStatuses(r), ['Z@0:no-match', 'G@100:pending', 'timeout@600:triggered']);
  // z 事件的重启判定失败后缓冲清空，g 是全新起算
  assert.equal(r.events[0].restartedFrom, null);
  // 回放结束仍待定 => 按超时触发短序列
  assert.equal(r.pendingAtEnd, true);
  assert.equal(r.finalStatus, 'triggered');
  const timeoutEv = r.events.find((e) => e.type === 'timeout');
  assert.equal(timeoutEv.at, 600);
  assert.equal(timeoutEv.triggered[0].commandId, 'c2');
});

test('时序回放：无匹配前缀缓冲，从当前键重新起算可直接命中', () => {
  // 独立场景：只有 G / G D；先按错误键 z（无匹配），再快速按 g d
  const st = {
    contexts: [{ id: 'r', parentId: null, name: 'R' }],
    commands: [
      { id: 'g1', contextId: 'r', name: 'g-cmd', sequenceTokens: ['g'], sequenceLabel: 'G', description: '' },
      { id: 'gd1', contextId: 'r', name: 'gd-cmd', sequenceTokens: ['g', 'd'], sequenceLabel: 'G D', description: '' },
    ],
  };
  const r = replayTimeline(st, 'r', {
    timeoutMs: 500,
    presses: [{ press: 'z', at: 0 }, { press: 'g', at: 50 }, { press: 'd', at: 100 }],
  });
  assert.deepEqual(replayStatuses(r), ['Z@0:no-match', 'G@50:pending', 'D@100:triggered']);
  assert.equal(r.triggers[0].triggered[0].commandId, 'gd1');
});

test('时序回放：3 键序列快速续完触发长序列', () => {
  const st3 = {
    contexts: [{ id: 'r', parentId: null, name: 'R' }],
    commands: [
      { id: 's1', contextId: 'r', name: 'g-cmd', sequenceTokens: ['g'], sequenceLabel: 'G', description: '' },
      { id: 's3', contextId: 'r', name: 'gdd-cmd', sequenceTokens: ['g', 'd', 'd'], sequenceLabel: 'G D D', description: '' },
    ],
  };
  const fast = replayTimeline(st3, 'r', {
    timeoutMs: 500,
    presses: [{ press: 'g', at: 0 }, { press: 'd', at: 200 }, { press: 'd', at: 400 }],
  });
  assert.deepEqual(replayStatuses(fast), ['G@0:pending', 'D@200:waiting', 'D@400:triggered']);
  assert.equal(fast.triggers.length, 1);
  assert.equal(fast.triggers[0].triggered[0].commandId, 's3');
});

test('时序回放：3 键序列等待中断尾键不匹配，从当前键重新起算且不补发短序列', () => {
  const st3 = {
    contexts: [{ id: 'r', parentId: null, name: 'R' }],
    commands: [
      { id: 's1', contextId: 'r', name: 'g-cmd', sequenceTokens: ['g'], sequenceLabel: 'G', description: '' },
      { id: 's3', contextId: 'r', name: 'gdd-cmd', sequenceTokens: ['g', 'd', 'd'], sequenceLabel: 'G D D', description: '' },
    ],
  };
  // g 待定 → d 在阈值内（等待 G D D，短序列 G 已取消待定）→ q 不匹配：从 q 重新起算仍无匹配
  const r = replayTimeline(st3, 'r', {
    timeoutMs: 500,
    presses: [{ press: 'g', at: 0 }, { press: 'd', at: 200 }, { press: 'q', at: 900 }],
  });
  assert.deepEqual(replayStatuses(r), ['G@0:pending', 'D@200:waiting', 'Q@900:no-match']);
  assert.equal(r.finalStatus, 'no-match');
  assert.equal(r.triggers.length, 0); // 短序列 G 在进入 waiting 时已取消，不补发
});

test('时序回放：待定中续错键则从当前键重新起算，不吞当前键', () => {
  // g 待定；阈值内按 q（root 下无匹配）→ 从 q 重新起算仍无匹配；g 待定被取代不补发
  const r = replay('root', [
    { press: 'g', at: 0 },
    { press: 'q', at: 100 },
  ]);
  assert.deepEqual(replayStatuses(r), ['G@0:pending', 'Q@100:no-match']);
  assert.equal(r.events[1].restartedFrom, 'G');
  // g 的短序列待定被「重新起算」取代，不再补发超时
  assert.equal(r.pendingAtEnd, false);
  assert.equal(r.finalStatus, 'no-match');
  assert.equal(r.triggers.length, 0);
});

test('时序回放：待定中续错键，当前键自身命中另一短序列', () => {
  // root：X（c1）、G（c2）、G D（c3）。g 待定后阈值内按 x：x 单独精确命中
  const r = replay('root', [
    { press: 'g', at: 0 },
    { press: 'x', at: 100 },
  ]);
  assert.deepEqual(replayStatuses(r), ['G@0:pending', 'X@100:triggered']);
  assert.equal(r.events[1].restartedFrom, 'G');
  assert.equal(r.triggers.length, 1);
  assert.equal(r.triggers[0].triggered[0].commandId, 'c1');
});

test('时序回放：精确命中且非前缀时立即触发（不进入待定，duplicate 双方同时触发）', () => {
  // a 层 Y/Y 同层重复，且 Y 不是任何序列前缀
  const r = replay('a', [{ press: 'y', at: 0 }], 500);
  assert.deepEqual(replayStatuses(r), ['Y@0:triggered']);
  assert.equal(r.triggers[0].trigger, 'exact');
  assert.deepEqual(r.triggers[0].triggered.map((t) => t.commandId).sort(), ['c5', 'c6']);
  assert.equal(r.pendingAtEnd, false);
});

test('时序回放：触发后缓冲清空，后续序列独立判定', () => {
  const r = replay('root', [
    { press: 'g', at: 0 },
    { press: 'd', at: 100 }, // 触发 G D，清空缓冲
    { press: 'g', at: 900 }, // 新序列：进入待定
  ]);
  assert.deepEqual(replayStatuses(r), ['G@0:pending', 'D@100:triggered', 'G@900:pending', 'timeout@1400:triggered']);
  assert.equal(r.triggers.length, 2); // 长序列 G D + 末尾待定补发短序列 G
  assert.equal(r.triggers[0].triggered[0].commandId, 'c3');
  assert.equal(r.triggers[1].trigger, 'timeout');
  assert.equal(r.triggers[1].triggered[0].commandId, 'c2');
  assert.equal(r.pendingAtEnd, true); // 末尾 g 待定，按超时补发 c2
  const timeoutEv = r.events.find((e) => e.type === 'timeout');
  assert.equal(timeoutEv.triggered[0].commandId, 'c2');
  assert.equal(timeoutEv.at, 1400);
});

test('时序回放：回放结束仍等待则保留 waiting，不补发触发', () => {
  const st2 = {
    contexts: [{ id: 'r', parentId: null, name: 'R' }],
    commands: [{ id: 'z1', contextId: 'r', name: 'zab', sequenceTokens: ['z', 'a', 'b'], sequenceLabel: 'Z A B', description: '' }],
  };
  const r = replayTimeline(st2, 'r', { timeoutMs: 500, presses: [{ press: 'z', at: 0 }] });
  assert.deepEqual(replayStatuses(r), ['Z@0:waiting']);
  assert.equal(r.finalStatus, 'waiting');
  assert.equal(r.triggers.length, 0);
});

test('时序回放：字符串 presses 与缺省 at（快速序列，间隔 0）', () => {
  const r = replayTimeline(state, 'root', { presses: 'g d', timeoutMs: 500 });
  assert.deepEqual(replayStatuses(r), ['G@0:pending', 'D@0:triggered']);
  assert.equal(r.triggers[0].triggered[0].commandId, 'c3');
});

test('时序回放：非法输入被拒绝（400）', () => {
  assert.throws(() => replayTimeline(state, 'root', { presses: [] }), /非空/);
  assert.throws(() => replayTimeline(state, 'root', { presses: [{ press: 'g', at: -1 }] }), /非负整数/);
  assert.throws(
    () => replayTimeline(state, 'root', { presses: [{ press: 'g', at: 10 }, { press: 'd', at: 5 }] }),
    /不能早于/,
  );
  assert.throws(() => replayTimeline(state, 'root', { presses: 'g', timeoutMs: -1 }), /超时阈值/);
  assert.throws(() => replayTimeline(state, 'root', { presses: [{ press: 'ctrl+alt' }] }), /主键/);
  assert.throws(() => replayTimeline(state, 'missing', { presses: 'g' }), /上下文不存在/);
});

test('上下文路径展示双方来源', () => {
  const eff = computeEffective(state, 'b');
  const conflict = eff.conflicts.find((c) => c.type === 'prefix');
  assert.ok(conflict.parties.every((p) => typeof p.contextPath === 'string' && p.contextPath.length > 0));
  const labels = conflict.parties.map((p) => p.shortestLabel);
  assert.ok(labels.includes('G') && labels.includes('G D'));
});

// ---------- 回归套件生成 ----------
test('回归套件：叶子候选与精确集合覆盖（最小叶子数）', () => {
  const suite = generateRegressionSuite(state);
  // 叶子：B 与 Sibling（Root、A 不是叶子）
  assert.equal(suite.stats.leafCount, 2);
  assert.deepEqual(
    suite.candidates.map((c) => c.contextId).sort(),
    ['b', 'sibling'],
  );
  // 目标：8 条命令在至少一个叶子可触发（c1 在 Sibling 生效）+ duplicate 1
  // + prefix 2（B 下 c7⊂c3 与 Sibling 下 c2⊂c3 是两个不同冲突身份）
  assert.equal(suite.stats.triggerableCommandCount, 8);
  assert.equal(suite.stats.duplicateConflictCount, 1);
  assert.equal(suite.stats.prefixConflictCount, 2);
  assert.equal(suite.stats.coveredGoalCount, suite.stats.coverableGoalCount);
  // 必须同时入选两个叶子：Sibling 独有 c8/k，B 独有 duplicate 与跨层 prefix
  assert.equal(suite.stats.selectedContextCount, 2);
  const selectedIds = suite.suite.map((tc) => tc.contextId).sort();
  assert.deepEqual(selectedIds, ['b', 'sibling']);

  const bCase = suite.suite.find((tc) => tc.contextId === 'b');
  // 每个入选上下文列出输入序列、预期触发命令集合
  const yInput = bCase.inputs.find((i) => i.sequenceLabel === 'Y');
  assert.equal(yInput.duplicate, true);
  assert.deepEqual(
    yInput.expectedCommands.map((c) => c.commandId).sort(),
    ['c5', 'c6'],
  );
  // 预期冲突类型同时包含 duplicate 与 prefix
  assert.deepEqual(
    bCase.expectedConflicts.map((c) => c.type).sort(),
    ['duplicate', 'prefix'],
  );
});

test('回归套件：任何叶子都无法触发的命令单列原因，不计入覆盖', () => {
  // u1 定义在根、序列 S：在叶子 B 被 A 层同序列覆盖，在叶子 S 被自身同序列覆盖
  const st = {
    contexts: [
      { id: 'r', parentId: null, name: 'R' },
      { id: 'a', parentId: 'r', name: 'A' },
      { id: 'b', parentId: 'a', name: 'B' },
      { id: 's', parentId: 'r', name: 'S' },
    ],
    commands: [
      { id: 'u1', contextId: 'r', name: 'r-save', sequenceTokens: ['s'], sequenceLabel: 'S', description: '' },
      { id: 'a1', contextId: 'a', name: 'a-save', sequenceTokens: ['s'], sequenceLabel: 'S', description: '' },
      { id: 's1', contextId: 's', name: 's-save', sequenceTokens: ['s'], sequenceLabel: 'S', description: '' },
      { id: 'ok', contextId: 'r', name: 'r-quit', sequenceTokens: ['q'], sequenceLabel: 'Q', description: '' },
    ],
  };
  const suite = generateRegressionSuite(st);
  const unreachable = suite.unreachableCommands.find((u) => u.commandId === 'u1');
  assert.ok(unreachable, 'u1 应列为不可触发');
  assert.match(unreachable.reason, /覆盖/);
  assert.deepEqual(unreachable.shadowedBy.map((s) => s.contextId).sort(), ['a', 's']);
  // 不可触发命令不算可触发、不算已覆盖
  assert.equal(suite.stats.triggerableCommandCount, 3); // a1 / s1 / ok
  assert.equal(suite.stats.unreachableCommandCount, 1);
  assert.ok(
    !suite.suite.some((tc) => tc.inputs.some((i) => i.expectedCommands.some((c) => c.commandId === 'u1'))),
  );
  // 但可触发目标仍被完整覆盖
  assert.equal(suite.stats.coveredGoalCount, suite.stats.coverableGoalCount);
});

test('回归套件：定义在非叶子上下文且子树无覆盖时命令仍可在叶子触发', () => {
  // c2(root G)、c3(root G D) 在 A、B、Sibling 都生效
  const suite = generateRegressionSuite(state);
  assert.ok(!suite.unreachableCommands.some((u) => u.commandId === 'c2'));
  assert.ok(!suite.unreachableCommands.some((u) => u.commandId === 'c3'));
});

test('回归套件：非叶子上下文独占（无叶子后代）的命令不可触发', () => {
  const st = {
    contexts: state.contexts,
    commands: [
      ...state.commands,
      { id: 'c11', contextId: 'a', name: 'a-only', sequenceTokens: ['q'], sequenceLabel: 'Q', description: '' },
      { id: 'c12', contextId: 'b', name: 'b-cover-q', sequenceTokens: ['q'], sequenceLabel: 'Q', description: '' },
    ],
  };
  const suite = generateRegressionSuite(st);
  // A 有子 B：Q 在 B 被覆盖，A 没有其他叶子后代
  const u = suite.unreachableCommands.find((x) => x.commandId === 'c11');
  assert.ok(u);
  assert.match(u.reason, /全部 1 个叶子/);
});

test('回归套件：同解时按上下文路径字典序稳定选择', () => {
  // 两个叶子 zfirst / asecond 覆盖目标完全相同 => 任选其一；应选路径字典序更小的
  const st = {
    contexts: [
      { id: 'r', parentId: null, name: 'R' },
      { id: 'zc', parentId: 'r', name: 'Zchild', description: '' },
      { id: 'ac', parentId: 'r', name: 'Achild', description: '' },
    ],
    commands: [
      { id: 'm1', contextId: 'r', name: 'm-save', sequenceTokens: ['s'], sequenceLabel: 'S', description: '' },
    ],
  };
  const suite = generateRegressionSuite(st);
  assert.equal(suite.stats.selectedContextCount, 1);
  assert.equal(suite.suite[0].contextId, 'ac'); // R / Achild < R / Zchild
});

test('minimumSetCover：最小数量 + 字典序平局的基本性质', () => {
  const mk = (contextPath, arr) => ({ contextPath, covers: new Set(arr) });
  const candidates = [
    mk('Z', ['x']),
    mk('A', ['x']), // 与 Z 同覆盖，路径更小
    mk('M', ['y']),
    mk('B', ['x', 'y']),
  ];
  const picked = minimumSetCover(candidates, new Set(['x', 'y']));
  assert.equal(picked.length, 1);
  assert.equal(picked[0].contextPath, 'B'); // 单集合可覆盖全部

  const picked2 = minimumSetCover(
    [mk('Z', ['x']), mk('A', ['x']), mk('Y', ['y']), mk('B', ['y'])],
    new Set(['x', 'y']),
  );
  assert.deepEqual(picked2.map((c) => c.contextPath).sort(), ['A', 'B']);
});

test('conflictGoalId：参与命令集合相同即同一冲突身份', () => {
  const dup1 = { type: 'duplicate', parties: [{ commandId: 'c5' }, { commandId: 'c6' }] };
  const dup2 = { type: 'duplicate', parties: [{ commandId: 'c6' }, { commandId: 'c5' }] };
  assert.equal(conflictGoalId(dup1), conflictGoalId(dup2));
  const pre1 = {
    type: 'prefix',
    parties: [
      { commandId: 'c2', role: 'prefix' },
      { commandId: 'c3', role: 'extension' },
    ],
  };
  const pre2 = {
    type: 'prefix',
    parties: [
      { commandId: 'c3', role: 'extension' },
      { commandId: 'c2', role: 'prefix' },
    ],
  };
  assert.equal(conflictGoalId(pre1), conflictGoalId(pre2));
  assert.notEqual(conflictGoalId(pre1), conflictGoalId(dup1));
});

// ---------- 变更沙盒预演 ----------
// 结构：R → A → B（B 为唯一叶子）；m1(R,S) 在 B 被 m2(A,S) 覆盖 => 基线不可触发
const sandboxState = {
  contexts: [
    { id: 'r', parentId: null, name: 'R' },
    { id: 'a', parentId: 'r', name: 'A' },
    { id: 'b', parentId: 'a', name: 'B' },
  ],
  commands: [
    { id: 'm1', contextId: 'r', name: 'root-save', sequenceTokens: ['s'], sequenceLabel: 'S', description: '' },
    { id: 'm2', contextId: 'a', name: 'a-save', sequenceTokens: ['s'], sequenceLabel: 'S', description: '' },
    { id: 'm3', contextId: 'a', name: 'a-jump', sequenceTokens: ['j'], sequenceLabel: 'J', description: '' },
  ],
};

test('沙盒预演：空草案与基线完全一致', () => {
  const res = previewSandbox(sandboxState, {});
  assert.equal(res.stats.totalChanges, 0);
  assert.equal(res.contexts.length, 0);
  assert.equal(res.unreachable.appeared.length, 0);
  assert.equal(res.unreachable.disappeared.length, 0);
});

test('沙盒预演：删除命令后祖先绑定恢复生效，按上下文汇总', () => {
  const res = previewSandbox(sandboxState, { deletes: ['m2'] });
  const ctxB = res.contexts.find((c) => c.contextId === 'b');
  assert.ok(ctxB, 'B 应有变化');
  // m2 的生效绑定消失，m1 从 shadowed 变为生效
  assert.ok(ctxB.effective.disappeared.some((e) => e.commandId === 'm2'));
  assert.ok(ctxB.effective.appeared.some((e) => e.commandId === 'm1'));
  assert.ok(ctxB.shadowed.disappeared.some((e) => e.commandId === 'm1'));
  // 差异条目携带来源路径与最短触发输入
  const m1 = ctxB.effective.appeared.find((e) => e.commandId === 'm1');
  assert.equal(m1.contextPath, 'R');
  assert.equal(m1.shortestLabel, 'S');
  // 被删除命令的条目标记草案来源
  assert.equal(ctxB.effective.disappeared.find((e) => e.commandId === 'm2').draftOp, 'delete');
  // A 层同样受影响，R 层无变化
  assert.ok(res.contexts.some((c) => c.contextId === 'a'));
  assert.ok(!res.contexts.some((c) => c.contextId === 'r'));
});

test('沙盒预演：新增命令在目标上下文及后代生效，不影响祖先', () => {
  const res = previewSandbox(sandboxState, {
    adds: [{ draftId: 'd1', contextId: 'a', name: 'new-cmd', sequence: 'n' }],
  });
  const ctxA = res.contexts.find((c) => c.contextId === 'a');
  const item = ctxA.effective.appeared.find((e) => e.commandId === 'd1');
  assert.equal(item.draftOp, 'add');
  assert.equal(item.contextPath, 'R / A');
  assert.equal(item.shortestLabel, 'N');
  assert.ok(res.contexts.some((c) => c.contextId === 'b'), '后代 B 同样生效');
  assert.ok(!res.contexts.some((c) => c.contextId === 'r'), '祖先 R 不受影响');
});

test('沙盒预演：改序列引发绑定与冲突的新增/消失', () => {
  // m3: J → S，与 m2 构成同层重复；原 J 绑定消失
  const res = previewSandbox(sandboxState, { updates: [{ commandId: 'm3', sequence: 's' }] });
  const ctxA = res.contexts.find((c) => c.contextId === 'a');
  assert.ok(ctxA.effective.disappeared.some((e) => e.commandId === 'm3' && e.sequenceLabel === 'J'));
  assert.ok(ctxA.effective.appeared.some((e) => e.commandId === 'm3' && e.sequenceLabel === 'S'));
  assert.equal(ctxA.effective.appeared.find((e) => e.commandId === 'm3').draftOp, 'update');
  // 同层重复冲突 {m2, m3} 新增，冲突条目带来源与最短触发输入
  assert.equal(ctxA.duplicate.appeared.length, 1);
  const dup = ctxA.duplicate.appeared[0];
  assert.deepEqual(dup.parties.map((p) => p.commandId), ['m2', 'm3']); // 参与方按 id 稳定排序
  assert.ok(dup.parties.every((p) => p.contextPath && p.shortestLabel === 'S'));
});

test('沙盒预演：冲突以参与命令集合配对，集合不变则不计差异', () => {
  const st = {
    contexts: [{ id: 'r', parentId: null, name: 'R' }],
    commands: [
      { id: 'd1', contextId: 'r', name: 'x1', sequenceTokens: ['x'], sequenceLabel: 'X', description: '' },
      { id: 'd2', contextId: 'r', name: 'x2', sequenceTokens: ['x'], sequenceLabel: 'X', description: '' },
      { id: 'q1', contextId: 'r', name: 'q', sequenceTokens: ['q'], sequenceLabel: 'Q', description: '' },
    ],
  };
  // 只改无关命令 => 已有同层重复 {d1,d2} 不计为差异
  const res = previewSandbox(st, { updates: [{ commandId: 'q1', sequence: 'w' }] });
  const ctxR = res.contexts.find((c) => c.contextId === 'r');
  assert.equal(ctxR.duplicate.appeared.length, 0);
  assert.equal(ctxR.duplicate.disappeared.length, 0);
  // 加入第三条同序列命令 => 冲突身份变化：旧集合消失、新集合出现
  const res2 = previewSandbox(st, { adds: [{ draftId: 'd3', contextId: 'r', name: 'x3', sequence: 'x' }] });
  const ctx2 = res2.contexts.find((c) => c.contextId === 'r');
  assert.deepEqual(ctx2.duplicate.disappeared.map((c) => c.goalId), ['dup:d1,d2']);
  assert.deepEqual(ctx2.duplicate.appeared.map((c) => c.goalId), ['dup:d1,d2,d3']);
});

test('沙盒预演：前缀冲突按参与命令集合配对（角色不变即同一冲突）', () => {
  const st = {
    contexts: [{ id: 'r', parentId: null, name: 'R' }],
    commands: [
      { id: 'p1', contextId: 'r', name: 'pre', sequenceTokens: ['j'], sequenceLabel: 'J', description: '' },
      { id: 'p2', contextId: 'r', name: 'ext', sequenceTokens: ['j', 'k'], sequenceLabel: 'J K', description: '' },
    ],
  };
  // 延伸方序列细节变化但参与集合与角色不变 => 同一冲突身份，不计差异
  const same = previewSandbox(st, { updates: [{ commandId: 'p2', sequence: 'j l' }] });
  const ctxR = same.contexts.find((c) => c.contextId === 'r');
  assert.equal(ctxR.prefix.appeared.length, 0);
  assert.equal(ctxR.prefix.disappeared.length, 0);
  // 前缀方改走 => 冲突消失
  const gone = previewSandbox(st, { updates: [{ commandId: 'p1', sequence: 'h' }] });
  const ctxR2 = gone.contexts.find((c) => c.contextId === 'r');
  assert.deepEqual(ctxR2.prefix.disappeared.map((c) => c.goalId), ['pre:p1::p2']);
  assert.equal(ctxR2.prefix.appeared.length, 0);
});

test('沙盒预演：不可触发命令的新增与消失', () => {
  // 基线：m1 在唯一叶子 B 被 m2 覆盖 => 不可触发；删除 m2 后恢复可触发
  const res = previewSandbox(sandboxState, { deletes: ['m2'] });
  assert.deepEqual(res.unreachable.disappeared.map((u) => u.commandId), ['m1']);
  assert.equal(res.unreachable.appeared.length, 0);
  // 反向：在 B 新增同序列命令 => m2 变为不可触发（附原因）
  const res2 = previewSandbox(sandboxState, {
    adds: [{ draftId: 'x1', contextId: 'b', name: 'b-save', sequence: 's' }],
  });
  const m2 = res2.unreachable.appeared.find((u) => u.commandId === 'm2');
  assert.ok(m2, 'm2 应变为不可触发');
  assert.match(m2.reason, /覆盖/);
  assert.equal(m2.contextPath, 'R / A');
});

test('沙盒预演：结果与数据顺序、草案操作顺序无关', () => {
  const draft = {
    adds: [
      { draftId: 'n1', contextId: 'a', name: 'n1', sequence: 'n' },
      { draftId: 'n2', contextId: 'b', name: 'n2', sequence: 'm' },
    ],
    updates: [{ commandId: 'm3', sequence: 'u' }],
    deletes: ['m2'],
  };
  const r1 = previewSandbox(sandboxState, draft);
  // 打乱：上下文顺序、命令顺序、草案内操作顺序全部颠倒
  const shuffled = {
    contexts: [...sandboxState.contexts].reverse(),
    commands: [...sandboxState.commands].reverse(),
  };
  const draft2 = {
    deletes: ['m2'],
    updates: [{ commandId: 'm3', sequence: 'u' }],
    adds: [
      { draftId: 'n2', contextId: 'b', name: 'n2', sequence: 'm' },
      { draftId: 'n1', contextId: 'a', name: 'n1', sequence: 'n' },
    ],
  };
  const r2 = previewSandbox(shuffled, draft2);
  const strip = (r) => {
    const { generatedAt, ...rest } = r;
    return rest;
  };
  assert.deepEqual(strip(r1), strip(r2));
});

test('沙盒预演：非法草案被拒绝', () => {
  assert.throws(
    () => previewSandbox(sandboxState, { updates: [{ commandId: 'm3', sequence: 'a b c d' }] }),
    /新序列无效/,
  );
  assert.throws(() => previewSandbox(sandboxState, { deletes: ['nope'] }), /不存在/);
  assert.throws(
    () => previewSandbox(sandboxState, { deletes: ['m2'], updates: [{ commandId: 'm2', sequence: 'x' }] }),
    /已在草案中删除/,
  );
  assert.throws(
    () => previewSandbox(sandboxState, { adds: [{ draftId: 'm1', contextId: 'a', name: 'x', sequence: 'x' }] }),
    /重复/,
  );
  assert.throws(
    () => previewSandbox(sandboxState, { adds: [{ draftId: 'z', contextId: 'nope', name: 'x', sequence: 'x' }] }),
    /上下文不存在/,
  );
});

test('沙盒预演：纯内存计算，不修改基线状态', () => {
  const before = JSON.stringify(sandboxState);
  previewSandbox(sandboxState, {
    adds: [{ draftId: 'n1', contextId: 'a', name: 'n1', sequence: 'n' }],
    updates: [{ commandId: 'm3', sequence: 'u' }],
    deletes: ['m2'],
  });
  assert.equal(JSON.stringify(sandboxState), before);
});

console.log(`\n引擎测试全部通过：${passed} 项`);