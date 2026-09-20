import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { eventToToken, tokenToPretty } from '../keyEvents';

/**
 * 时序回放：
 * - 录制每次按键相对录制起点的毫秒时间戳，超时阈值可配置；
 * - 后端按时间线复用当前上下文的生效绑定判定（短序列先待定，阈值内续键触发长序列，
 *   超时触发短序列，无匹配从当前键重新起算）；
 * - 页面逐事件展示状态、候选与最终触发命令（含触发时间点），支持 JSON 导入 / 导出。
 */

const REPLAY_DOC_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 800;

const STATUS_META = {
  idle: { text: '空闲', cls: 'idle' },
  pending: { text: '待定（等待续键或超时）', cls: 'pending' },
  waiting: { text: '等待后续按键…', cls: 'waiting' },
  triggered: { text: '命令已触发', cls: 'triggered' },
  'no-match': { text: '无匹配序列', cls: 'nomatch' },
};

const TRIGGER_META = {
  exact: { label: '立即触发', cls: 'trig-exact' },
  'pending-continue': { label: '阈值内续键触发', cls: 'trig-continue' },
  timeout: { label: '超时触发', cls: 'trig-timeout' },
};

function triggerName(t) {
  return TRIGGER_META[t]?.label || t;
}

/** 生成一份演示数据（基于当前上下文的生效序列挑选 G/GD 类组合，找不到则用第一个单/双键命令） */
function buildSample(state, contextId, timeoutMs) {
  const chain = new Set();
  const byId = new Map(state.contexts.map((c) => [c.id, c]));
  let cur = byId.get(contextId);
  const guard = new Set();
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    chain.add(cur.id);
    cur = cur.parentId ? byId.get(cur.parentId) : null;
  }
  const available = state.commands.filter((c) => chain.has(c.contextId));
  const single = available.find((c) => c.sequenceTokens.length === 1);
  const multi = available.find((c) => c.sequenceTokens.length >= 2);

  if (single && multi) {
    return {
      timeoutMs,
      presses: [
        { press: multi.sequenceTokens[0], at: 0 },
        { press: multi.sequenceTokens[1], at: timeoutMs + 200 },
        { press: single.sequenceTokens[0], at: timeoutMs + 400 },
      ],
      note: `先慢速输入「${multi.sequenceLabel}」（首键超时触发短序列），再触发「${single.sequenceLabel}」`,
    };
  }
  const any = multi || single;
  if (!any) return { timeoutMs, presses: [{ press: 'g', at: 0 }] };
  return {
    timeoutMs,
    presses: any.sequenceTokens.map((token, i) => ({ press: token, at: i * 120 })),
  };
}

function TriggerBadge({ trigger }) {
  const meta = TRIGGER_META[trigger] || { label: trigger, cls: '' };
  return <span className={`trigger-kind ${meta.cls}`}>{meta.label}</span>;
}

function EventCandidates({ event }) {
  if (!event.candidates || event.candidates.length === 0) return null;
  return (
    <ul className="replay-candidates">
      {event.candidates.map((c) => (
        <li key={c.sequenceTokens.join('')}>
          <kbd className="seq">{c.sequenceLabel}</kbd>
          <span className="candidate-cmds">
            {c.commands.map((cmd) => (
              <span key={cmd.commandId} className="candidate-cmd">
                {cmd.name}
                <span className="party-source">（{cmd.contextPath}）</span>
              </span>
            ))}
          </span>
          <span className="remaining">还差 {c.remaining} 键</span>
        </li>
      ))}
    </ul>
  );
}

function EventRow({ event, index }) {
  const isTimeout = event.type === 'timeout';
  const meta = STATUS_META[event.status] || { text: event.status, cls: '' };
  return (
    <div className={`replay-event status-${meta.cls} ${isTimeout ? 'is-timeout' : ''}`}>
      <div className="replay-event-head">
        <span className="replay-event-index">#{index + 1}</span>
        <span className="replay-event-time">
          <strong>{event.at}</strong> ms
        </span>
        {isTimeout ? (
          <span className="replay-event-key">⏱ 超时</span>
        ) : (
          <span className="replay-event-key">
            <kbd>{event.press}</kbd>
          </span>
        )}
        <span className={`sim-status ${meta.cls}`}>
          <span className="status-dot" />
          {meta.text}
        </span>
        {event.restartedFrom && (
          <span className="badge replay-restart" title={`从「${event.restartedFrom}」之后的当前按键重新起算`}>
            ↻ 自「{event.restartedFrom}」重新起算
          </span>
        )}
        {event.pending && (
          <span className="badge replay-deadline">
            待定截止 {event.pending.deadlineAt} ms（阈值 {event.pending.timeoutMs}ms）
          </span>
        )}
      </div>

      {event.note && <p className="replay-note">{event.note}</p>}

      {event.status === 'triggered' && (
        <ul className="trigger-list">
          {event.triggered.map((t) => (
            <li key={t.commandId}>
              <strong>{t.name}</strong>
              <span className="party-source">来源：{t.contextPath}</span>
              <span className="party-trigger">
                序列：<kbd>{t.sequenceLabel}</kbd>
              </span>
              {t.duplicate && <span className="badge duplicate">同层重复，多个命令同时触发</span>}
            </li>
          ))}
        </ul>
      )}

      {(event.status === 'pending' || event.status === 'waiting') && <EventCandidates event={event} />}
    </div>
  );
}

export default function TimelineReplay({ state, initialContextId }) {
  const [contextId, setContextId] = useState(initialContextId || '');
  const [timeoutMs, setTimeoutMsRaw] = useState(DEFAULT_TIMEOUT_MS);
  const [presses, setPresses] = useState([]); // [{ token, label, at }]
  const [recording, setRecording] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [running, setRunning] = useState(false);
  const recorderRef = useRef(null);
  const recordStartRef = useRef(0);

  // 上下文列表（带路径）
  const contexts = useMemo(() => {
    const byId = new Map(state.contexts.map((c) => [c.id, c]));
    const pathOf = (id) => {
      const names = [];
      const guard = new Set();
      let cur = byId.get(id);
      while (cur && !guard.has(cur.id)) {
        guard.add(cur.id);
        names.unshift(cur.name);
        cur = cur.parentId ? byId.get(cur.parentId) : null;
      }
      return names.join(' / ') || id;
    };
    return state.contexts
      .map((c) => ({ id: c.id, path: pathOf(c.id) }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }, [state]);

  // 默认上下文：跟随审校页选择
  useEffect(() => {
    if ((!contextId || !state.contexts.some((c) => c.id === contextId)) && state.contexts.length > 0) {
      const preferred = initialContextId && state.contexts.some((c) => c.id === initialContextId)
        ? initialContextId
        : state.contexts.find((c) => !c.parentId)?.id || state.contexts[0].id;
      setContextId(preferred);
    }
  }, [state, initialContextId, contextId]);

  const runReplay = async (nextPresses = presses, nextTimeout = timeoutMs, nextCtx = contextId) => {
    if (!nextCtx) return;
    if (nextPresses.length === 0) {
      setResult(null);
      setError('');
      return;
    }
    setRunning(true);
    try {
      const r = await api.replay(nextCtx, {
        timeoutMs: nextTimeout,
        presses: nextPresses.map((p) => ({ press: p.token, at: p.at })),
      });
      setResult(r);
      setError('');
    } catch (err) {
      setResult(null);
      setError(err.message);
    } finally {
      setRunning(false);
    }
  };

  // 按键 / 阈值 / 上下文变化后自动回放
  useEffect(() => {
    runReplay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presses, timeoutMs, contextId]);

  // ---- 录制 ----
  const startRecording = () => {
    setPresses([]);
    setResult(null);
    setNotice('');
    recordStartRef.current = performance.now();
    setRecording(true);
    setTimeout(() => recorderRef.current?.focus(), 0);
  };

  useEffect(() => {
    if (!recording) return undefined;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setRecording(false);
        return;
      }
      if (e.key === 'Backspace') {
        e.preventDefault();
        setPresses((prev) => prev.slice(0, -1));
        return;
      }
      e.preventDefault();
      const token = eventToToken(e);
      if (!token) return;
      const at = Math.max(0, Math.round(performance.now() - recordStartRef.current));
      setPresses((prev) => [...prev, { token, label: tokenToPretty(token), at }]);
    };
    const node = recorderRef.current;
    node?.addEventListener('keydown', onKeyDown);
    return () => node?.removeEventListener('keydown', onKeyDown);
  }, [recording]);

  const updateAt = (index, value) => {
    const n = Math.max(0, Math.floor(Number(value) || 0));
    setPresses((prev) => {
      if (prev[index].at === n) return prev;
      const next = prev.map((p, i) => (i === index ? { ...p, at: n } : p));
      // 保持单调不减：向更早的键传播较小值，向更晚的键抬高
      for (let i = 1; i < next.length; i++) {
        if (next[i].at < next[i - 1].at) next[i] = { ...next[i], at: next[i - 1].at };
      }
      return next;
    });
  };

  const removePress = (index) => setPresses((prev) => prev.filter((_, i) => i !== index));
  const clearPresses = () => {
    setPresses([]);
    setResult(null);
    setNotice('');
  };

  const loadSample = () => {
    const sample = buildSample(state, contextId, timeoutMs);
    setRecording(false);
    setTimeoutMsRaw(sample.timeoutMs);
    setPresses(sample.presses.map((p) => ({ token: p.press, label: tokenToPretty(p.press), at: p.at })));
    setNotice(sample.note ? `已载入演示序列：${sample.note}` : '已载入演示序列');
  };

  // ---- JSON 导入 / 导出 ----
  const fileRef = useRef(null);

  const exportJson = () => {
    if (presses.length === 0) return;
    const doc = {
      docType: 'shortcut-timeline-replay',
      version: REPLAY_DOC_VERSION,
      exportedAt: new Date().toISOString(),
      contextId,
      timeoutMs,
      presses: presses.map((p) => ({ press: p.token, at: p.at })),
      result, // 附带最近一次后端回放结果，导入时仅用于参考，重放以后端最新状态为准
    };
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `timeline-replay-${contextId}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const importJsonFile = async (file) => {
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      setError('导入失败：文件不是合法 JSON');
      return;
    }
    // 支持完整文档，也支持直接粘贴 { timeoutMs, presses }
    const body = parsed || {};
    const rawPresses = body?.presses;
    if (!Array.isArray(rawPresses) || rawPresses.length === 0) {
      setError('导入失败：JSON 中缺少非空的 presses 数组');
      return;
    }
    const nextCtx =
      body.contextId && state.contexts.some((c) => c.id === body.contextId)
        ? body.contextId
        : contextId;
    const nextTimeout =
      Number.isFinite(Number(body.timeoutMs)) && Number(body.timeoutMs) >= 0
        ? Math.floor(Number(body.timeoutMs))
        : DEFAULT_TIMEOUT_MS;
    const next = [];
    for (const item of rawPresses) {
      const pressRaw = typeof item === 'string' ? item : item?.press;
      const at = typeof item === 'object' && item !== null && item.at !== undefined ? Math.max(0, Math.floor(Number(item.at) || 0)) : null;
      if (typeof pressRaw !== 'string' || !pressRaw.trim()) {
        setError('导入失败：presses 中存在缺少 press 字段的条目');
        return;
      }
      const token = pressRaw.trim().toLowerCase();
      next.push({ token, label: tokenToPretty(token), at: at === null ? (next.length ? next[next.length - 1].at : 0) : at });
    }
    // 单调不减修正
    for (let i = 1; i < next.length; i++) {
      if (next[i].at < next[i - 1].at) next[i] = { ...next[i], at: next[i - 1].at };
    }
    setRecording(false);
    setContextId(nextCtx);
    setTimeoutMsRaw(nextTimeout);
    setPresses(next);
    setResult(null);
    setError('');
    setNotice(`已导入 ${next.length} 次按键${body.contextId && body.contextId !== nextCtx ? '（原文档上下文不存在，已沿用当前选择）' : ''}`);
  };

  const onFileChange = (e) => {
    const file = e.target.files?.[0];
    if (file) importJsonFile(file);
    e.target.value = '';
  };

  const finalMeta = result ? STATUS_META[result.finalStatus] || { text: result.finalStatus, cls: '' } : null;
  const gaps = presses.map((p, i) => (i === 0 ? 0 : p.at - presses[i - 1].at));

  return (
    <div className="regression-page replay-page">
      <div className="regression-toolbar">
        <div className="regression-title">
          <h2>🎞 时序回放（可配置超时）</h2>
          <span className="dim small">
            录制每次按键的相对毫秒与超时阈值 · 后端按时间线复用当前上下文生效绑定 · 短序列先待定，阈值内续键触发长序列，超时触发短序列，无匹配从当前键重新起算
          </span>
        </div>
        <div className="regression-actions">
          <button onClick={loadSample}>载入演示序列</button>
          <button onClick={() => fileRef.current?.click()}>导入 JSON</button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={onFileChange}
          />
          <button className="primary" onClick={exportJson} disabled={presses.length === 0}>
            导出 JSON
          </button>
        </div>
      </div>

      {notice && (
        <p className="sandbox-notice">
          <span>ℹ {notice}</span>
          <button onClick={() => setNotice('')}>知道了</button>
        </p>
      )}
      {error && <p className="error">⚠ {error}</p>}

      <div className="panel">
        <div className="panel-header">
          <h2>① 回放配置</h2>
        </div>
        <div className="replay-config">
          <label className="replay-field">
            <span className="dim small">目标上下文（生效绑定按最近祖先规则判定）</span>
            <select value={contextId} onChange={(e) => setContextId(e.target.value)}>
              {contexts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.path}
                </option>
              ))}
            </select>
          </label>
          <label className="replay-field replay-timeout-field">
            <span className="dim small">超时阈值（毫秒）</span>
            <input
              type="number"
              min="0"
              max="60000"
              step="50"
              value={timeoutMs}
              onChange={(e) => setTimeoutMsRaw(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
            />
            <span className="dim small">待定短序列经此间隔未续键即触发；恰好等于间隔按超时处理</span>
          </label>
        </div>

        <div
          ref={recorderRef}
          tabIndex={0}
          className={`recorder replay-recorder ${recording ? 'armed' : ''}`}
        >
          {recording ? (
            <>
              <div className="buffer">
                <span className="buffer-empty">
                  ● 录制中… 已录 {presses.length} 键（Esc 结束录制 · Backspace 删除最后一键 · 单按修饰键不计入）
                </span>
              </div>
              <div className="buffer">
                {presses.map((p, i) => (
                  <React.Fragment key={i}>
                    <kbd className="press">{p.label}</kbd>
                    <span className="press-at">@{p.at}ms</span>
                    {i < presses.length - 1 && <span className="press-sep">·</span>}
                  </React.Fragment>
                ))}
              </div>
            </>
          ) : (
            <div className="buffer">
              <span className="buffer-empty">点击「开始录制」后在此按键；也可以直接在下表编辑毫秒时间点</span>
            </div>
          )}
        </div>

        <div className="replay-recorder-actions">
          {!recording ? (
            <button className="primary" onClick={startRecording}>
              ● 开始录制（清空并重新计时）
            </button>
          ) : (
            <button onClick={() => setRecording(false)}>■ 结束录制</button>
          )}
          <button onClick={clearPresses} disabled={presses.length === 0}>
            清空按键
          </button>
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">
          <h2>
            ② 按键时间线 <span className="sub">{presses.length} 次按键 · 相对毫秒（可编辑）</span>
          </h2>
        </div>
        {presses.length === 0 ? (
          <p className="hint">尚未录制按键。开始录制、载入演示序列或导入 JSON 后在此查看与编辑。</p>
        ) : (
          <table className="bind-table replay-press-table">
            <thead>
              <tr>
                <th style={{ width: 48 }}>#</th>
                <th style={{ width: 120 }}>按键</th>
                <th style={{ width: 150 }}>时间点 (ms)</th>
                <th style={{ width: 150 }}>距上一键 (ms)</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {presses.map((p, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td>
                    <kbd className="seq">{p.label}</kbd>
                  </td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      value={p.at}
                      onChange={(e) => updateAt(i, e.target.value)}
                    />
                  </td>
                  <td className={gaps[i] > timeoutMs ? 'gap-over' : 'gap-ok'}>
                    {i === 0 ? '—' : `+${gaps[i]}`}
                    {i > 0 && gaps[i] > timeoutMs && <span className="dim small">（超过阈值）</span>}
                  </td>
                  <td className="row-actions">
                    <button className="danger" onClick={() => removePress(i)}>
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {result && (
        <div className="panel">
          <div className="panel-header">
            <h2>
              ③ 回放结果 <span className="sub">{result.contextPath}</span>
            </h2>
            <span className={`sim-status ${finalMeta.cls}`}>
              <span className="status-dot" />
              最终：{finalMeta.text}
            </span>
          </div>

          <div className="replay-summary">
            <span className="dim small">
              阈值 {result.timeoutMs}ms · 时间线长度 {result.durationMs}ms · 事件 {result.events.length} 个 · 触发{' '}
              {result.triggers.length} 次
              {result.pendingAtEnd ? ' · 回放结束时仍待定，已按超时补发短序列' : ''}
              {running ? ' · 重新计算中…' : ''}
            </span>
          </div>

          {result.triggers.length > 0 && (
            <div className="sim-section">
              <h4>✅ 最终触发命令（按时间点）</h4>
              <ul className="replay-trigger-list">
                {result.triggers.map((t, i) => (
                  <li key={i}>
                    <span className="replay-trigger-time">@{t.at}ms</span>
                    <TriggerBadge trigger={t.trigger} />
                    <span className="candidate-cmds">
                      {t.triggered.map((cmd) => (
                        <span key={cmd.commandId} className="candidate-cmd">
                          {cmd.name}
                          <span className="party-source">（{cmd.contextPath}）</span>
                          {cmd.duplicate && <span className="badge duplicate">同层重复</span>}
                        </span>
                      ))}
                    </span>
                    <span className="party-trigger">
                      输入：<kbd>{t.bufferLabel}</kbd>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="sim-section">
            <h4>📋 逐事件状态</h4>
            <div className="replay-events">
              {result.events.map((ev, i) => (
                <EventRow key={i} event={ev} index={i} />
              ))}
            </div>
          </div>
        </div>
      )}

      {presses.length === 0 && !error && (
        <p className="hint">配置目标上下文与超时阈值后，录制或导入按键序列，页面将自动请求后端进行时序回放。</p>
      )}
    </div>
  );
}
