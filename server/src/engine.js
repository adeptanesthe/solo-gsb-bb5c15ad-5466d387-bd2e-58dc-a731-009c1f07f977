/**
 * 快捷键审校引擎
 * - 最近祖先规则：沿 contextId → parent 向上查找，最深层（最近祖先）的绑定生效
 * - 同层相同序列：重复绑定，双方均触发但标记 duplicate 冲突
 * - 前缀冲突：任一生效序列是另一生效序列的严格前缀时，双方标记 prefix 冲突
 * - 被更深层同序列覆盖的祖先绑定标记为 shadowed（不生效）
 */

const MAX_PRESSES = 3;

const MODIFIERS = new Set(['ctrl', 'alt', 'shift', 'meta']);

/**
 * 规范化单次按键（支持 Ctrl+K 这种组合键，算作“一次按键”）。
 * 返回 { ok, token, error }
 */
function canonicalPress(raw) {
  const segment = String(raw || '').trim().toLowerCase();
  if (!segment) return { ok: false, error: '空按键' };
  const parts = segment
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return { ok: false, error: '空按键' };

  const mods = [];
  const keys = [];
  for (const p of parts) {
    if (MODIFIERS.has(p)) {
      if (!mods.includes(p)) mods.push(p);
    } else {
      keys.push(p);
    }
  }
  if (keys.length !== 1) {
    return { ok: false, error: `按键 "${raw}" 必须恰好包含一个主键（修饰键：Ctrl/Alt/Shift/Meta）` };
  }
  const order = ['ctrl', 'alt', 'shift', 'meta'];
  mods.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  // 规范展示：Ctrl+K
  const pretty = [...mods, keys[0]]
    .map((p) => (MODIFIERS.has(p) ? p[0].toUpperCase() + p.slice(1) : p.length === 1 ? p.toUpperCase() : p))
    .join('+');
  return { ok: true, token: [...mods, keys[0]].join('+'), pretty };
}

/**
 * 解析序列输入。接受空格或逗号分隔的 1~3 次按键，例如：
 *   "g l"  /  "ctrl+k, x"  /  "Ctrl+Shift+p"
 */
function parseSequence(raw) {
  const text = String(raw || '').trim();
  if (!text) return { ok: false, error: '请输入 1~3 次按键' };
  const segments = text.split(/[\s,]+/).filter(Boolean);
  if (segments.length < 1 || segments.length > MAX_PRESSES) {
    return { ok: false, error: `序列必须由 1~${MAX_PRESSES} 次按键组成，当前 ${segments.length} 次` };
  }
  const tokens = [];
  const labels = [];
  for (const seg of segments) {
    const r = canonicalPress(seg);
    if (!r.ok) return { ok: false, error: r.error };
    tokens.push(r.token);
    labels.push(r.pretty);
  }
  return { ok: true, tokens, label: labels.join(' ') };
}

function seqKey(tokens) {
  return tokens.join('');
}

function isPrefix(shorter, longer) {
  if (shorter.length >= longer.length) return false;
  return shorter.every((t, i) => t === longer[i]);
}

function buildIndex(contexts) {
  const byId = new Map();
  const roots = [];
  for (const c of contexts) {
    byId.set(c.id, { ...c, children: [] });
  }
  for (const c of byId.values()) {
    if (c.parentId && byId.has(c.parentId)) {
      byId.get(c.parentId).children.push(c);
    } else {
      roots.push(c);
    }
  }
  return { byId, roots };
}

/** 从某上下文向上到根的链（含自身），自身在前 */
function ancestorChain(index, contextId) {
  const chain = [];
  let cur = index.byId.get(contextId);
  const guard = new Set();
  while (cur) {
    if (guard.has(cur.id)) break;
    guard.add(cur.id);
    chain.push(cur);
    cur = cur.parentId ? index.byId.get(cur.parentId) : null;
  }
  return chain;
}

function contextPath(index, contextId) {
  const chain = ancestorChain(index, contextId).reverse(); // 根 → 当前
  return chain.map((c) => c.name).join(' / ');
}

/**
 * 计算指定上下文下生效的全部绑定。
 * 返回 {
 *   contextId, contextPath, chain: [{id,name,depth}],
 *   entries: 所有绑定（含 shadowed）,
 *   effectiveGroups: 按序列分组的生效绑定,
 *   conflicts: 冲突清单（duplicate / prefix）
 * }
 */
function computeEffective(state, contextId) {
  const index = buildIndex(state.contexts);
  if (!index.byId.has(contextId)) {
    throw Object.assign(new Error('上下文不存在'), { status: 404 });
  }
  const chain = ancestorChain(index, contextId); // [自身, 父, ..., 根]
  const pathStr = contextPath(index, contextId);

  // 仅收集链上上下文定义的命令；链上深度：自身 0。按由近到远的深度排序处理
  const chainIds = new Set(chain.map((c) => c.id));
  const depthOf = new Map(chain.map((c, i) => [c.id, i]));

  const owned = state.commands
    .filter((cmd) => chainIds.has(cmd.contextId))
    .map((cmd) => ({
      cmd,
      contextId: cmd.contextId,
      ownerDepth: depthOf.get(cmd.contextId),
      contextPath: contextPath(index, cmd.contextId),
    }))
    .sort((a, b) => a.ownerDepth - b.ownerDepth);

  const groupsMap = new Map(); // seqKey -> { tokens, label, commands:[record...] }
  const shadowed = []; // 被覆盖的祖先绑定

  for (const record of owned) {
    const { cmd } = record;
    const key = seqKey(cmd.sequenceTokens);
    const existing = groupsMap.get(key);
    if (!existing) {
      groupsMap.set(key, {
        seqKey: key,
        tokens: [...cmd.sequenceTokens],
        label: cmd.sequenceLabel,
        commands: [record],
      });
    } else if (record.ownerDepth === existing.commands[0].ownerDepth) {
      existing.commands.push(record); // 同层重复（duplicate 冲突，双方均生效）
    } else {
      // 更深祖先（更大 depth）的同序列绑定被最近祖先覆盖
      shadowed.push({ ...record, overriddenByDepth: existing.commands[0].ownerDepth });
    }
  }

  // 组状态：同层多命令 => duplicate
  const effectiveGroups = [...groupsMap.values()].map((g) => ({
    ...g,
    duplicate: g.commands.length > 1,
  }));

  // 前缀冲突：生效组两两比较（跨越不同层级也算）
  const prefixPairs = []; // [shortGroup, longGroup]
  for (let i = 0; i < effectiveGroups.length; i++) {
    for (let j = 0; j < effectiveGroups.length; j++) {
      if (i === j) continue;
      const a = effectiveGroups[i];
      const b = effectiveGroups[j];
      if (isPrefix(a.tokens, b.tokens)) {
        prefixPairs.push([a, b]);
      }
    }
  }
  const prefixShortKeys = new Set(prefixPairs.map(([a]) => a.seqKey));
  const prefixLongKeys = new Set(prefixPairs.map(([, b]) => b.seqKey));

  // 汇总 entries
  const entries = [];
  for (const g of effectiveGroups) {
    const prefixRole = prefixShortKeys.has(g.seqKey)
      ? 'prefix'
      : prefixLongKeys.has(g.seqKey)
        ? 'extension'
        : null;
    for (const rec of g.commands) {
      entries.push({
        commandId: rec.cmd.id,
        name: rec.cmd.name,
        description: rec.cmd.description || '',
        contextId: rec.contextId,
        contextPath: rec.contextPath,
        ownerDepth: rec.ownerDepth,
        sequenceTokens: g.tokens,
        sequenceLabel: g.label,
        state: g.duplicate ? 'duplicate' : 'active',
        shadowedBy: null,
        duplicate: g.duplicate,
        prefix: prefixRole, // 'prefix' | 'extension' | null
      });
    }
  }
  for (const rec of shadowed) {
    entries.push({
      commandId: rec.cmd.id,
      name: rec.cmd.name,
      description: rec.cmd.description || '',
      contextId: rec.contextId,
      contextPath: rec.contextPath,
      ownerDepth: rec.ownerDepth,
      sequenceTokens: rec.cmd.sequenceTokens,
      sequenceLabel: rec.cmd.sequenceLabel,
      state: 'shadowed',
      shadowedBy: chain[rec.overriddenByDepth]?.id ?? null,
      duplicate: false,
      prefix: null,
    });
  }
  entries.sort((a, b) => a.sequenceLabel.localeCompare(b.sequenceLabel) || a.ownerDepth - b.ownerDepth);

  // 冲突清单
  const conflicts = [];
  for (const g of effectiveGroups.filter((g) => g.duplicate)) {
    conflicts.push({
      type: 'duplicate',
      kindLabel: '同层序列重复',
      sequenceLabel: g.label,
      sequenceTokens: g.tokens,
      parties: g.commands.map((rec) => ({
        commandId: rec.cmd.id,
        name: rec.cmd.name,
        contextId: rec.contextId,
        contextPath: rec.contextPath,
        sequenceLabel: g.label,
        shortestLabel: g.label,
      })),
    });
  }
  for (const [shortG, longG] of prefixPairs) {
    conflicts.push({
      type: 'prefix',
      kindLabel: '前缀冲突',
      prefixSequenceLabel: shortG.label,
      extensionSequenceLabel: longG.label,
      prefixTokens: shortG.tokens,
      extensionTokens: longG.tokens,
      parties: [
        ...shortG.commands.map((rec) => ({
          commandId: rec.cmd.id,
          name: rec.cmd.name,
          contextId: rec.contextId,
          contextPath: rec.contextPath,
          sequenceLabel: shortG.label,
          shortestLabel: shortG.label,
          role: 'prefix',
        })),
        ...longG.commands.map((rec) => ({
          commandId: rec.cmd.id,
          name: rec.cmd.name,
          contextId: rec.contextId,
          contextPath: rec.contextPath,
          sequenceLabel: longG.label,
          shortestLabel: longG.label,
          role: 'extension',
        })),
      ],
    });
  }

  return {
    contextId,
    contextPath: pathStr,
    chain: chain.map((c, i) => ({ id: c.id, name: c.name, depth: i })).reverse(),
    entries,
    effectiveGroups,
    conflicts,
  };
}

/**
 * 逐键模拟：给定已经按下的按键缓冲，返回当前状态。
 * status:
 *   idle       尚未输入
 *   triggered  精确命中，命令已触发
 *   waiting    已构成某些命令序列的前缀，等待后续按键
 *   no-match   无任何匹配（含缓冲到 3 键仍未命中）
 */
function evaluateKey(state, contextId, bufferTokens) {
  const eff = computeEffective(state, contextId);
  const buffer = bufferTokens || [];

  if (buffer.length === 0) {
    return { status: 'idle', buffer, bufferLabel: '', triggered: [], candidates: [], effective: eff };
  }

  const bufferLabel = buffer.map((t) => pressToPretty(t)).join(' ');
  const groups = eff.effectiveGroups;

  const exact = groups.filter((g) => g.tokens.length === buffer.length && g.tokens.every((t, i) => t === buffer[i]));
  const prefixed = groups.filter((g) => isPrefix(buffer, g.tokens));

  const toCandidate = (g) => ({
    sequenceLabel: g.label,
    sequenceTokens: g.tokens,
    commands: g.commands.map((rec) => ({
      commandId: rec.cmd.id,
      name: rec.cmd.name,
      contextPath: rec.contextPath,
      contextId: rec.contextId,
    })),
    remaining: g.tokens.length - buffer.length,
  });

  if (exact.length > 0) {
    const triggered = [];
    for (const g of exact) {
      for (const rec of g.commands) {
        triggered.push({
          commandId: rec.cmd.id,
          name: rec.cmd.name,
          description: rec.cmd.description || '',
          contextPath: rec.contextPath,
          sequenceLabel: g.label,
          duplicate: g.duplicate,
        });
      }
    }
    // 精确命中的同时若仍是更长序列前缀，给出提示候选
    return {
      status: 'triggered',
      buffer,
      bufferLabel,
      triggered,
      candidates: prefixed.map(toCandidate),
      effective: eff,
    };
  }

  if (prefixed.length > 0 && buffer.length < MAX_PRESSES) {
    return {
      status: 'waiting',
      buffer,
      bufferLabel,
      triggered: [],
      candidates: prefixed.map(toCandidate).sort((a, b) => a.remaining - b.remaining),
      effective: eff,
    };
  }

  return { status: 'no-match', buffer, bufferLabel, triggered: [], candidates: [], effective: eff };
}

/** 收集某上下文子树内的全部叶子上下文（无子上下文） */
function descendantLeaves(index, contextId) {
  const start = index.byId.get(contextId);
  if (!start) return [];
  const out = [];
  const walk = (node) => {
    if (node.children.length === 0) out.push(node);
    else node.children.forEach(walk);
  };
  walk(start);
  return out;
}

/**
 * 冲突的稳定身份：同一组命令形成的冲突在不同叶子下视为同一个测试目标。
 * - duplicate：dup:<双方命令id排序>
 * - prefix：pre:<前缀方命令id排序>::<延伸方命令id排序>
 */
function conflictGoalId(conflict) {
  if (conflict.type === 'duplicate') {
    const ids = conflict.parties.map((p) => p.commandId).sort();
    return `dup:${ids.join(',')}`;
  }
  const prefixIds = conflict.parties
    .filter((p) => p.role === 'prefix')
    .map((p) => p.commandId)
    .sort();
  const extensionIds = conflict.parties
    .filter((p) => p.role === 'extension')
    .map((p) => p.commandId)
    .sort();
  return `pre:${prefixIds.join(',')}::${extensionIds.join(',')}`;
}

function setCoversAll(container, subset) {
  for (const g of subset) if (!container.has(g)) return false;
  return true;
}

/** 路径数组字典序比较（排序后比较；短前缀更小） */
function lexLessPaths(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] < b[i]) return true;
    if (a[i] > b[i]) return false;
  }
  return a.length < b.length;
}

/**
 * 精确集合覆盖：在候选集合中找出覆盖 universe 所需候选数量最少的组合。
 * candidates 已按 contextPath 字典序升序排列；同解（数量相同）时保留
 * 入选路径排序后字典序最小的组合，保证结果稳定、与数据顺序无关。
 * 分支限界（MRV 选目标 + 覆盖数下界 + 贪心初始上界 + 记忆剪枝），精确求解。
 */
function minimumSetCover(candidates, universe) {
  if (universe.size === 0 || candidates.length === 0) return [];

  // 按路径字典序排序，使支配精简与平局判定不依赖调用方的传入顺序
  const sorted = candidates
    .slice()
    .sort((a, b) => (a.contextPath < b.contextPath ? -1 : a.contextPath > b.contextPath ? 1 : 0));

  // 支配精简：仅允许“路径字典序更小且覆盖为超集”的候选淘汰后者，
  // 这样不会丢掉可能构成字典序更优同解的候选。
  const alive = sorted.map(() => true);
  for (let b = 1; b < sorted.length; b++) {
    for (let a = 0; a < b; a++) {
      if (alive[a] && setCoversAll(sorted[a].covers, sorted[b].covers)) {
        alive[b] = false;
        break;
      }
    }
  }
  const sets = sorted.filter((_, i) => alive[i]);

  // 贪心求一个可行上界（同等新增覆盖数时取路径更小者）
  const greedyPick = () => {
    const remaining = new Set(universe);
    const picked = [];
    while (remaining.size > 0) {
      let bestIdx = -1;
      let bestCount = -1;
      sets.forEach((c, ci) => {
        let n = 0;
        for (const g of c.covers) if (remaining.has(g)) n++;
        if (
          n > bestCount ||
          (n === bestCount && bestIdx >= 0 && c.contextPath < sets[bestIdx].contextPath)
        ) {
          bestIdx = ci;
          bestCount = n;
        }
      });
      picked.push(bestIdx);
      for (const g of sets[bestIdx].covers) remaining.delete(g);
    }
    return picked;
  };

  let bestChosen = greedyPick();
  let bestPaths = bestChosen.map((ci) => sets[ci].contextPath).sort();
  const chosen = [];
  const memo = new Map(); // remaining 签名 -> 到达它时最少的已选数量（仅严格更劣才剪枝）

  const consider = () => {
    const paths = chosen.map((ci) => sets[ci].contextPath).sort();
    if (paths.length < bestPaths.length || (paths.length === bestPaths.length && lexLessPaths(paths, bestPaths))) {
      bestPaths = paths;
      bestChosen = chosen.slice();
    }
  };

  const dfs = (remaining) => {
    if (remaining.size === 0) {
      consider();
      return;
    }
    const key = [...remaining].sort().join('|');
    const prevDepth = memo.get(key);
    if (prevDepth !== undefined && prevDepth < chosen.length) return;
    memo.set(key, chosen.length);

    // 下界：剩余目标数 / 单集合最大新增覆盖数
    let maxCoverage = 0;
    for (const c of sets) {
      let n = 0;
      for (const g of c.covers) if (remaining.has(g)) n++;
      if (n > maxCoverage) maxCoverage = n;
    }
    if (chosen.length + Math.ceil(remaining.size / maxCoverage) > bestPaths.length) return;

    // MRV：选能覆盖它的候选数最少的未覆盖目标分支；候选保持路径字典序
    let branchSets = null;
    for (const goal of remaining) {
      const cs = [];
      sets.forEach((c, ci) => {
        if (c.covers.has(goal)) cs.push(ci);
      });
      if (!branchSets || cs.length < branchSets.length) {
        branchSets = cs;
        if (cs.length === 1) break;
      }
    }

    for (const ci of branchSets) {
      chosen.push(ci);
      const next = new Set(remaining);
      for (const g of sets[ci].covers) next.delete(g);
      dfs(next);
      chosen.pop();
    }
  };

  dfs(new Set(universe));
  return bestChosen.map((ci) => sets[ci]);
}

/**
 * 叶子分析：在全部叶子上下文上复用 computeEffective 的生效规则，
 * 汇总每条命令可触发的叶子、被覆盖的位置（shadower）与叶子可见冲突
 * （冲突以参与命令集合判定身份）。供回归套件与变更沙盒预演共用。
 */
function analyzeLeaves(state) {
  const index = buildIndex(state.contexts);
  const leaves = [...index.byId.values()]
    .filter((c) => c.children.length === 0)
    .map((c) => ({ id: c.id, path: contextPath(index, c.id) }))
    .sort((a, b) => (a.path === b.path ? (a.id < b.id ? -1 : 1) : a.path < b.path ? -1 : 1));

  // 每个叶子跑一次现有审校规则
  const reviews = leaves.map((leaf) => ({ leaf, eff: computeEffective(state, leaf.id) }));

  const triggerLeafIds = new Map(); // commandId -> 可触发它的叶子 id 列表
  const shadowerCounter = new Map(); // commandId -> Map(覆盖者 contextId -> 叶子数)
  const conflictGoals = new Map(); // goalId -> 冲突对象（代表）

  for (const { leaf, eff } of reviews) {
    for (const e of eff.entries) {
      if (e.state === 'shadowed') {
        if (e.shadowedBy) {
          if (!shadowerCounter.has(e.commandId)) shadowerCounter.set(e.commandId, new Map());
          const m = shadowerCounter.get(e.commandId);
          m.set(e.shadowedBy, (m.get(e.shadowedBy) || 0) + 1);
        }
      } else if (!triggerLeafIds.has(e.commandId)) {
        triggerLeafIds.set(e.commandId, [leaf.id]);
      } else {
        triggerLeafIds.get(e.commandId).push(leaf.id);
      }
    }
    for (const c of eff.conflicts) {
      const goalId = conflictGoalId(c);
      if (!conflictGoals.has(goalId)) conflictGoals.set(goalId, c);
    }
  }
  return { index, leaves, reviews, triggerLeafIds, shadowerCounter, conflictGoals };
}

/**
 * 不可触发命令：不在任何叶子生效的命令，单列原因与覆盖位置。
 * analysis 可选，传入 analyzeLeaves 的结果以避免重复计算。
 */
function listUnreachableCommands(state, analysis) {
  const { index, triggerLeafIds, shadowerCounter } = analysis || analyzeLeaves(state);
  const unreachableCommands = [];
  for (const cmd of state.commands) {
    if (triggerLeafIds.has(cmd.id)) continue;
    const leavesUnder = descendantLeaves(index, cmd.contextId);
    let reason;
    let shadowedBy = [];
    if (leavesUnder.length === 0) {
      reason = '所属上下文的子树中不存在叶子上下文，没有可执行该命令的测试位置';
    } else {
      const m = shadowerCounter.get(cmd.id);
      if (m && m.size > 0) {
        shadowedBy = [...m.keys()]
          .map((sid) => ({ contextId: sid, contextPath: contextPath(index, sid) }))
          .sort((a, b) => (a.contextPath < b.contextPath ? -1 : a.contextPath > b.contextPath ? 1 : 0));
        reason =
          `序列「${cmd.sequenceLabel}」在所属上下文（${contextPath(index, cmd.contextId)}）子树下的全部 ` +
          `${leavesUnder.length} 个叶子上下文中均被更近祖先的同序列绑定覆盖（shadowed，覆盖位置：` +
          `${shadowedBy.map((s) => s.contextPath).join('、')}），任何叶子都无法触发该命令`;
      } else {
        reason = '该命令未出现在任何叶子上下文的生效绑定中，无法从叶子上下文触发';
      }
    }
    unreachableCommands.push({
      commandId: cmd.id,
      name: cmd.name,
      description: cmd.description || '',
      contextId: cmd.contextId,
      contextPath: contextPath(index, cmd.contextId),
      sequenceTokens: cmd.sequenceTokens,
      sequenceLabel: cmd.sequenceLabel,
      reason,
      shadowedBy,
    });
  }
  unreachableCommands.sort((a, b) =>
    a.contextPath === b.contextPath
      ? a.sequenceLabel.localeCompare(b.sequenceLabel) || (a.commandId < b.commandId ? -1 : 1)
      : a.contextPath < b.contextPath
        ? -1
        : 1,
  );
  return unreachableCommands;
}

/**
 * 回归套件生成：
 * 1. 以全部叶子上下文为候选，复用 computeEffective 的生效规则；
 * 2. 测试目标 = 每条可在某个叶子触发的命令 + 每个可在某个叶子观察到的
 *    同层重复（duplicate）/ 前缀冲突（prefix），冲突以参与命令集合判定身份；
 * 3. 精确集合覆盖选出叶子数量最少的套件，同解按上下文路径字典序稳定选择；
 * 4. 任何叶子都无法触发的命令列入 unreachableCommands 并给出原因，不计入覆盖。
 */
function generateRegressionSuite(state) {
  const analysis = analyzeLeaves(state);
  const { leaves, reviews, triggerLeafIds, conflictGoals } = analysis;

  // 不可触发命令：不在任何叶子生效的命令，单列原因且不计入覆盖目标
  const unreachableCommands = listUnreachableCommands(state, analysis);

  // 覆盖目标全集：可触发命令 + 叶子可见冲突
  const universe = new Set();
  for (const id of triggerLeafIds.keys()) universe.add(`cmd:${id}`);
  for (const id of conflictGoals.keys()) universe.add(id);

  // 候选叶子及其覆盖的目标集合
  const candidates = reviews
    .map(({ leaf, eff }) => {
      const covers = new Set();
      for (const e of eff.entries) {
        if (e.state !== 'shadowed') covers.add(`cmd:${e.commandId}`);
      }
      for (const c of eff.conflicts) covers.add(conflictGoalId(c));
      return { contextId: leaf.id, contextPath: leaf.path, covers, eff };
    })
    .filter((c) => c.covers.size > 0);
  // leaves 已按路径排序，candidates 保持路径字典序，供集合覆盖平局判定使用

  const selected = minimumSetCover(candidates, universe);
  const selectedIds = new Set(selected.map((c) => c.contextId));

  const suite = selected.map((c) => {
    const eff = c.eff;
    const inputs = eff.effectiveGroups
      .slice()
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((g) => ({
        sequenceLabel: g.label,
        sequenceTokens: g.tokens,
        duplicate: g.duplicate,
        expectedCommands: g.commands
          .map((rec) => ({
            commandId: rec.cmd.id,
            name: rec.cmd.name,
            contextPath: rec.contextPath,
          }))
          .sort((a, b) => a.name.localeCompare(b.name) || (a.commandId < b.commandId ? -1 : 1)),
      }));
    return {
      contextId: c.contextId,
      contextPath: c.contextPath,
      inputs,
      expectedConflicts: eff.conflicts,
      coveredGoals: [...c.covers].sort(),
    };
  });
  suite.sort((a, b) => (a.contextPath < b.contextPath ? -1 : a.contextPath > b.contextPath ? 1 : 0));

  let duplicateConflictCount = 0;
  let prefixConflictCount = 0;
  for (const c of conflictGoals.values()) {
    if (c.type === 'duplicate') duplicateConflictCount++;
    else prefixConflictCount++;
  }

  const coveredGoals = new Set();
  for (const c of selected) for (const g of c.covers) coveredGoals.add(g);
  const coveredCommandCount = [...coveredGoals].filter((g) => g.startsWith('cmd:')).length;

  return {
    generatedAt: new Date().toISOString(),
    stats: {
      leafCount: leaves.length,
      candidateCount: candidates.length,
      selectedContextCount: suite.length,
      commandCount: state.commands.length,
      triggerableCommandCount: triggerLeafIds.size,
      coveredCommandCount,
      unreachableCommandCount: unreachableCommands.length,
      conflictCount: conflictGoals.size,
      duplicateConflictCount,
      prefixConflictCount,
      inputSequenceCount: suite.reduce((n, tc) => n + tc.inputs.length, 0),
      coverableGoalCount: universe.size,
      coveredGoalCount: coveredGoals.size,
    },
    suite,
    candidates: candidates.map((c) => ({
      contextId: c.contextId,
      contextPath: c.contextPath,
      goalCount: c.covers.size,
      selected: selectedIds.has(c.contextId),
    })),
    unreachableCommands,
  };
}

function pressToPretty(token) {
  const MOD_PRETTY = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Meta' };
  return token
    .split('+')
    .map((p) => (MOD_PRETTY[p] ? MOD_PRETTY[p] : p.length === 1 ? p.toUpperCase() : p))
    .join('+');
}

/* ================= 变更沙盒预演 ================= */

/**
 * 把草案（新增 / 改序列 / 删除）应用到状态副本上，返回模拟状态。
 * 纯内存计算：不触碰持久化数据，也不修改传入的 baseState；
 * 所有校验失败均抛出 400，保证非法草案不会产生任何副作用。
 *
 * draft = {
 *   adds:    [{ draftId?, contextId, name, sequence, description? }]
 *   updates: [{ commandId, sequence }]      // 仅改序列
 *   deletes: [commandId, ...]               // 也接受 { commandId }
 * }
 */
function applyDraft(baseState, draft) {
  const d = draft || {};
  const adds = Array.isArray(d.adds) ? d.adds : [];
  const updates = Array.isArray(d.updates) ? d.updates : [];
  const deletes = Array.isArray(d.deletes) ? d.deletes : [];

  const bad = (message) => Object.assign(new Error(message), { status: 400 });

  const contexts = baseState.contexts.map((c) => ({ ...c }));
  const contextIds = new Set(contexts.map((c) => c.id));
  let commands = baseState.commands.map((c) => ({ ...c, sequenceTokens: [...c.sequenceTokens] }));

  const draftOps = new Map(); // commandId -> 'add' | 'update' | 'delete'

  // 1) 删除
  const deletedIds = new Set();
  for (const raw of deletes) {
    const id = typeof raw === 'string' ? raw : raw && raw.commandId;
    if (!id) throw bad('删除操作缺少命令 id');
    if (deletedIds.has(id)) throw bad(`草案中重复删除同一命令：${id}`);
    if (!commands.some((c) => c.id === id)) throw bad(`要删除的命令不存在：${id}`);
    deletedIds.add(id);
    draftOps.set(id, 'delete');
  }
  commands = commands.filter((c) => !deletedIds.has(c.id));

  // 2) 改序列
  const updatedIds = new Set();
  for (const u of updates) {
    if (!u || typeof u.commandId !== 'string' || !u.commandId) {
      throw bad('改序列操作缺少 commandId');
    }
    const id = u.commandId;
    if (deletedIds.has(id)) throw bad(`命令 ${id} 已在草案中删除，不能再修改序列`);
    if (updatedIds.has(id)) throw bad(`草案中重复修改同一命令的序列：${id}`);
    const cmd = commands.find((c) => c.id === id);
    if (!cmd) throw bad(`要修改序列的命令不存在：${id}`);
    const parsed = parseSequence(u.sequence);
    if (!parsed.ok) throw bad(`命令「${cmd.name}」的新序列无效：${parsed.error}`);
    cmd.sequenceRaw = String(u.sequence);
    cmd.sequenceTokens = parsed.tokens;
    cmd.sequenceLabel = parsed.label;
    updatedIds.add(id);
    draftOps.set(id, 'update');
  }

  // 3) 新增（draftId 由前端生成并在草案内保持稳定；缺省时按位置生成）
  const addedIds = new Set();
  adds.forEach((a, i) => {
    if (!a || typeof a !== 'object') throw bad('新增操作格式不正确');
    const draftId =
      typeof a.draftId === 'string' && a.draftId.trim() ? a.draftId.trim() : `draft-add-${i + 1}`;
    if (addedIds.has(draftId) || commands.some((c) => c.id === draftId)) {
      throw bad(`新增命令的 id 与现有命令或草案重复：${draftId}`);
    }
    if (!contextIds.has(a.contextId)) throw bad(`新增命令的上下文不存在：${a.contextId}`);
    if (!a.name || !String(a.name).trim()) throw bad('新增命令的名称不能为空');
    const parsed = parseSequence(a.sequence);
    if (!parsed.ok) {
      throw bad(`新增命令「${String(a.name).trim()}」的序列无效：${parsed.error}`);
    }
    addedIds.add(draftId);
    draftOps.set(draftId, 'add');
    commands.push({
      id: draftId,
      contextId: a.contextId,
      name: String(a.name).trim(),
      description: String(a.description || ''),
      sequenceRaw: String(a.sequence),
      sequenceTokens: parsed.tokens,
      sequenceLabel: parsed.label,
    });
  });

  return {
    state: { contexts, commands },
    draftOps,
    summary: {
      adds: addedIds.size,
      updates: updatedIds.size,
      deletes: deletedIds.size,
      addedCommandIds: [...addedIds].sort(),
      updatedCommandIds: [...updatedIds].sort(),
      deletedCommandIds: [...deletedIds].sort(),
    },
  };
}

/** 以稳定身份对两个列表做「新增 / 消失」配对（身份由 identityOf 给出） */
function diffByIdentity(baseItems, simItems, identityOf) {
  const baseKeys = new Set(baseItems.map(identityOf));
  const simKeys = new Set(simItems.map(identityOf));
  return {
    appeared: simItems.filter((item) => !baseKeys.has(identityOf(item))),
    disappeared: baseItems.filter((item) => !simKeys.has(identityOf(item))),
  };
}

/**
 * 变更沙盒预演：
 * 1. 在同一份草案上分别计算基线（当前状态）与模拟状态（应用草案后的内存副本）；
 * 2. 按上下文汇总生效绑定 / shadowed / duplicate / prefix 的新增与消失；
 *    不可触发命令为全局汇总（定义位置随条目给出）；
 * 3. 绑定以「命令 + 序列」配对，冲突以参与命令集合的稳定身份（conflictGoalId）配对；
 *    全部输出按稳定键排序，结果与数据顺序、草案操作顺序无关。
 */
function previewSandbox(baseState, draft) {
  const { state: simState, draftOps, summary } = applyDraft(baseState, draft);

  const simIndex = buildIndex(simState.contexts);
  const contextIds = [...simIndex.byId.keys()];

  // 绑定身份：同一命令绑定到同一序列视为同一绑定（改序列 => 旧绑定消失 + 新绑定出现）
  const bindingIdentity = (e) => `${e.commandId}\n${e.sequenceTokens.join('\n')}`;
  const byBinding = (a, b) =>
    a.sequenceLabel.localeCompare(b.sequenceLabel) ||
    (a.commandId < b.commandId ? -1 : a.commandId > b.commandId ? 1 : 0);
  const byGoalId = (a, b) => (a.goalId < b.goalId ? -1 : a.goalId > b.goalId ? 1 : 0);

  const toBindingItem = (e) => ({
    commandId: e.commandId,
    name: e.name,
    description: e.description || '',
    contextId: e.contextId,
    contextPath: e.contextPath,
    sequenceTokens: e.sequenceTokens,
    sequenceLabel: e.sequenceLabel,
    shortestLabel: e.sequenceLabel, // 绑定条目的最短触发输入即其序列本身
    state: e.state,
    shadowedBy: e.shadowedBy || null,
    draftOp: draftOps.get(e.commandId) || null,
  });

  const toConflictItem = (c) => ({
    ...c,
    goalId: conflictGoalId(c),
    parties: c.parties
      .map((p) => ({ ...p, draftOp: draftOps.get(p.commandId) || null }))
      .sort((a, b) => (a.commandId < b.commandId ? -1 : a.commandId > b.commandId ? 1 : 0)),
  });

  const contextDiffs = [];
  for (const contextId of contextIds) {
    const baseEff = computeEffective(baseState, contextId);
    const simEff = computeEffective(simState, contextId);

    const effective = diffByIdentity(
      baseEff.entries.filter((e) => e.state !== 'shadowed').map(toBindingItem),
      simEff.entries.filter((e) => e.state !== 'shadowed').map(toBindingItem),
      bindingIdentity,
    );
    const shadowed = diffByIdentity(
      baseEff.entries.filter((e) => e.state === 'shadowed').map(toBindingItem),
      simEff.entries.filter((e) => e.state === 'shadowed').map(toBindingItem),
      bindingIdentity,
    );
    const conflicts = diffByIdentity(
      baseEff.conflicts.map(toConflictItem),
      simEff.conflicts.map(toConflictItem),
      (c) => c.goalId,
    );

    const duplicate = {
      appeared: conflicts.appeared.filter((c) => c.type === 'duplicate').sort(byGoalId),
      disappeared: conflicts.disappeared.filter((c) => c.type === 'duplicate').sort(byGoalId),
    };
    const prefix = {
      appeared: conflicts.appeared.filter((c) => c.type === 'prefix').sort(byGoalId),
      disappeared: conflicts.disappeared.filter((c) => c.type === 'prefix').sort(byGoalId),
    };
    effective.appeared.sort(byBinding);
    effective.disappeared.sort(byBinding);
    shadowed.appeared.sort(byBinding);
    shadowed.disappeared.sort(byBinding);

    const changeCount =
      effective.appeared.length +
      effective.disappeared.length +
      shadowed.appeared.length +
      shadowed.disappeared.length +
      duplicate.appeared.length +
      duplicate.disappeared.length +
      prefix.appeared.length +
      prefix.disappeared.length;

    if (changeCount > 0) {
      contextDiffs.push({
        contextId,
        contextPath: simEff.contextPath,
        changeCount,
        effective,
        shadowed,
        duplicate,
        prefix,
      });
    }
  }
  contextDiffs.sort((a, b) =>
    a.contextPath === b.contextPath
      ? a.contextId < b.contextId
        ? -1
        : 1
      : a.contextPath < b.contextPath
        ? -1
        : 1,
  );

  // 不可触发命令：全局（任何叶子都无法触发），按 commandId 配对
  const withDraftOp = (u) => ({ ...u, draftOp: draftOps.get(u.commandId) || null });
  const unreachableRaw = diffByIdentity(
    listUnreachableCommands(baseState),
    listUnreachableCommands(simState),
    (u) => u.commandId,
  );
  const unreachable = {
    appeared: unreachableRaw.appeared.map(withDraftOp),
    disappeared: unreachableRaw.disappeared.map(withDraftOp),
  };

  const sum = (sel) => contextDiffs.reduce((n, c) => n + sel(c).length, 0);
  const stats = {
    contextCount: contextIds.length,
    changedContextCount: contextDiffs.length,
    effectiveAppeared: sum((c) => c.effective.appeared),
    effectiveDisappeared: sum((c) => c.effective.disappeared),
    shadowedAppeared: sum((c) => c.shadowed.appeared),
    shadowedDisappeared: sum((c) => c.shadowed.disappeared),
    duplicateAppeared: sum((c) => c.duplicate.appeared),
    duplicateDisappeared: sum((c) => c.duplicate.disappeared),
    prefixAppeared: sum((c) => c.prefix.appeared),
    prefixDisappeared: sum((c) => c.prefix.disappeared),
    unreachableAppeared: unreachable.appeared.length,
    unreachableDisappeared: unreachable.disappeared.length,
  };
  stats.totalChanges =
    stats.effectiveAppeared +
    stats.effectiveDisappeared +
    stats.shadowedAppeared +
    stats.shadowedDisappeared +
    stats.duplicateAppeared +
    stats.duplicateDisappeared +
    stats.prefixAppeared +
    stats.prefixDisappeared +
    stats.unreachableAppeared +
    stats.unreachableDisappeared;

  return {
    generatedAt: new Date().toISOString(),
    draft: summary,
    stats,
    contexts: contextDiffs,
    unreachable,
  };
}

module.exports = {
  MAX_PRESSES,
  canonicalPress,
  parseSequence,
  seqKey,
  isPrefix,
  buildIndex,
  ancestorChain,
  contextPath,
  computeEffective,
  evaluateKey,
  descendantLeaves,
  conflictGoalId,
  minimumSetCover,
  analyzeLeaves,
  listUnreachableCommands,
  generateRegressionSuite,
  applyDraft,
  previewSandbox,
};
