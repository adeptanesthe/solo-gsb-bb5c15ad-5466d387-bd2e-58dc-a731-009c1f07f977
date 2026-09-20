# ⌨ 上下文快捷键审校台（Node.js + React）

为命令式快捷键体系提供的可视化审校工具：建立**上下文树**，为命令指定所属上下文与由 **1～3 次按键**组成的序列；选择任一上下文后，系统按**最近祖先规则**构建生效绑定，自动标出**同层重复**与**前缀冲突**，并提供**逐键模拟器**实时查看候选、触发与等待状态。此外可一键**生成回归测试套件**：以全部叶子上下文为候选，用精确集合覆盖选出叶子数量最少的测试上下文集合。新增的**变更沙盒**支持把命令的新增、改序列、删除先暂存为浏览器本地草案，后端在同一份草案上预演基线与模拟状态，按上下文汇总各项差异，改动确认前不触碰任何真实数据。

## 一条命令启动（Docker Compose）

```bash
docker compose up --build -d
```

然后浏览器访问：

> **http://localhost:3000**

端口：主机 `3000` → 容器 `3000`（可在 `docker-compose.yml` 的 `ports` 中修改左侧端口）。
停止：`docker compose down`；数据保存在命名卷 `shortcut-data` 中，重建容器不丢失。

> 镜像启动时自动完成数据初始化：首次运行若数据文件不存在，会写入一套包含覆盖、同层重复、前缀冲突等场景的演示数据（`server/src/seed.js`）。

---

## 本地开发（无 Docker）

要求 Node.js ≥ 18。

```bash
npm install          # 安装全部依赖（npm workspaces：server / client）
npm run dev          # 并行启动后端(3000) 与 Vite 前端(5173)
```

访问 **http://localhost:5173**（Vite 已把 `/api` 代理到后端 3000）。

其他命令：

```bash
npm run build        # 构建前端到 client/dist
npm start            # 仅启动后端；若已 build，则由后端在 3000 端口托管前端
npm run test:engine  # 运行引擎单测（最近祖先 / 覆盖 / 重复 / 前缀 / 逐键模拟 / 回归套件 / 沙盒预演）
```

## 数据模型

| 实体 | 字段 |
|---|---|
| 上下文 Context | `id`, `parentId`（可空，支持森林）, `name`, `description` |
| 命令 Command | `id`, `contextId`（定义位置）, `name`, `sequenceTokens`（1~3 次按键）, `description` |

序列输入用**空格或逗号**分隔，每次按键支持组合键（修饰键 `Ctrl/Alt/Shift/Meta` + 一个主键），例如：

- `g l`（2 次按键）
- `Ctrl+Shift+P`（1 次按键）
- `Ctrl+K, x`（2 次按键，第 1 次为组合键）

## 审校规则

选定上下文后，沿其祖先链（自身 → 父 → … → 根）收集绑定：

1. **最近祖先生效，子级覆盖祖先**：同一序列若在链上多层定义，最靠近所选上下文的一层生效；祖先层的同序列绑定显示为「已覆盖（shadowed）」，不参与触发与冲突判定。
2. **同层序列重复 = 冲突（duplicate）**：同一上下文中多条命令使用完全相同的序列，双方（全部）都保留并会在按键时**同时触发**，列表标记「同层重复」，冲突卡片列出每一方的**来源上下文路径**与**最短触发输入**。
3. **前缀冲突（prefix）**：生效序列中若 `A` 是 `B` 的严格前缀（如 `G` 与 `G D`，允许跨层），双方分别标记「他序列前缀 / 前缀延伸」，冲突卡片同时展示双方来源与各自最短触发输入。
4. 兄弟上下文的绑定互不可见。

## 逐键模拟器

在右下录制区点击获取键盘焦点后直接按键（支持单键与组合键，单按修饰键不计入）：

- **Esc** 清空缓冲，**Backspace** 回退一个按键；
- `triggered`（绿）：缓冲精确命中，展示已触发命令（重复时列出全部）；若它同时是更长序列前缀，附候选提示；
- `waiting`（黄）：缓冲是一个或多个生效序列的前缀，列出候选命令、来源与「还差 N 键」；
- `no-match`（红）：既未精确命中也不是任何序列前缀；
- `idle`：尚未输入。

## 回归套件生成

顶部切换到「🧪 回归套件生成」页（只读，不改动任何审校/模拟逻辑）：

1. **候选**：上下文树中的全部**叶子上下文**；对每个叶子直接复用 `computeEffective` 的生效规则（最近祖先 / 覆盖 / 同层重复 / 前缀冲突）。
2. **测试目标**：
   - 每条可在**至少一个叶子**触发的命令（shadowed 的绑定不计）；
   - 每个可在某个叶子观察到的**同层重复（duplicate）**或**前缀冲突（prefix）**；冲突以**参与命令集合**判定身份——不同叶子下命令集合相同的冲突视为同一个目标。
3. **选套件**：用**精确集合覆盖**（分支限界，MRV 选目标）选出覆盖全部目标所需**叶子数量最少**的组合；存在多个同解时，按入选上下文路径排序后的**字典序**稳定选择（与数据 id/加载顺序无关）。
4. 每个入选上下文给出一张测试用例：
   - **需输入的序列**：该叶子下全部生效序列；
   - **预期触发命令集合**：精确输入该序列时应同时触发的命令（含来源路径，同层重复时为多条）；
   - **预期冲突类型**：该叶子下的 duplicate / prefix 冲突清单（双方来源与最短触发输入）。
5. **不可触发命令**：任何叶子都无法触发的命令（典型原因：其序列在子树的**每个叶子**都被更近祖先的同序列绑定覆盖 shadowed）单列在警告区并给出原因与覆盖位置，**不计入覆盖目标**；页面覆盖率只统计「可触发命令 + 冲突目标」。

页面顶部展示覆盖统计（叶子数、入选数、已覆盖/可触发命令、不可触发命令、两类冲突数、目标覆盖率、输入序列总数），可一键**下载 JSON**（与 `GET /api/regression-suite` 返回内容一致）。

## 变更沙盒（草案预演）

顶部切换到「🛠 变更沙盒」页，可以在**不改动真实数据**的前提下评估一批命令变更的影响：

1. **暂存草案**：基于当前状态批量暂存命令的**新增**、**改序列**、**删除**。草案只保存在浏览器
   `localStorage`（键 `shortcut-sandbox-draft-v1`）——**既不写入数据文件，也不影响审校页**；
   刷新或重开页面草案仍在，可逐条撤销或一键**清空草案**。若数据在别处被改动导致草案操作失效
   （目标命令/上下文已不存在），页面会提示并自动剔除。
2. **预演**：草案非空时自动调用 `POST /api/sandbox/preview`（也可手动重新预演）。后端在同一份草案上
   分别计算**基线**（当前状态）与**模拟状态**（应用草案后的内存副本，绝不写回），复用与审校页完全
   相同的生效规则，按上下文汇总以下各项的**新增 / 消失**：
   - **生效绑定**（以「命令 + 序列」配对：改序列表现为旧绑定消失、新绑定出现）；
   - **shadowed**（被更近祖先同序列绑定覆盖的条目）；
   - **duplicate / prefix 冲突**（以**参与命令集合**的稳定身份配对：参与集合与角色不变的冲突
     不计差异；集合变化则旧身份消失、新身份出现）；
   - **不可触发命令**（全局汇总：任何叶子都无法触发的命令，附原因）。
3. **差异展示**：每项差异都给出**来源路径**（定义所在上下文路径）与**最短触发输入**，草案引入的
   条目带有「草案新增 / 改序列 / 删除」标记；绿色 ＋ 表示新增、红色 − 表示消失。
4. **导出**：可一键**下载预演 JSON**（与 `POST /api/sandbox/preview` 返回内容一致）。

预演结果完全确定：全部输出按稳定键排序，与数据文件中的顺序、草案操作的先后顺序无关。

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/state` | 全量上下文树与命令 |
| POST/PUT/DELETE | `/api/contexts[/:id]` | 上下文增改删（删除级联后代与其命令，移动时防环） |
| POST/PUT/DELETE | `/api/commands[/:id]` | 命令增改删，服务端校验序列合法性（1~3 键、组合键合法） |
| GET | `/api/review/:contextId` | 生效绑定、祖先链、冲突清单、shadowed 绑定 |
| POST | `/api/simulate/:contextId` | 逐键模拟，body：`{"buffer":["g","d"]}` 或 `{"presses":"g d"}` |
| GET | `/api/regression-suite` | 回归套件（统计 + 入选用例 + 候选覆盖数 + 不可触发命令原因）；加 `?download=1` 返回 `Content-Disposition: attachment` 响应头 |
| POST | `/api/sandbox/preview` | 变更沙盒预演（只读，不写数据文件）：body 为草案，返回基线 vs 模拟状态的按上下文差异；加 `?download=1` 返回附件响应头 |

`POST /api/sandbox/preview` 请求体（三类操作均可选，默认为空）：

```jsonc
{
  "adds":    [ { "draftId": "draft-x1", "contextId": "ctx-terminal", "name": "新命令", "sequence": "g w", "description": "" } ],
  "updates": [ { "commandId": "cmd-16", "sequence": "g l l" } ],   // 仅改序列
  "deletes": [ "cmd-10" ]                                          // 命令 id 数组
}
```

返回结构：

```jsonc
{
  "generatedAt": "…",
  "draft": { "adds": 1, "updates": 1, "deletes": 1,
             "addedCommandIds": ["draft-x1"], "updatedCommandIds": ["cmd-16"], "deletedCommandIds": ["cmd-10"] },
  "stats": {
    "contextCount": 4, "changedContextCount": 2,
    "effectiveAppeared": 3, "effectiveDisappeared": 2,
    "shadowedAppeared": 0, "shadowedDisappeared": 1,
    "duplicateAppeared": 1, "duplicateDisappeared": 0,
    "prefixAppeared": 4, "prefixDisappeared": 4,
    "unreachableAppeared": 0, "unreachableDisappeared": 1,
    "totalChanges": 16
  },
  "contexts": [                      // 仅列出有变化的上下文，按路径排序
    {
      "contextId": "ctx-terminal",
      "contextPath": "App / Editor / Terminal",
      "changeCount": 8,
      "effective": { "appeared": [ /* 绑定条目 */ ], "disappeared": [] },
      "shadowed":  { "appeared": [], "disappeared": [] },
      "duplicate": { "appeared": [ /* 冲突条目 */ ], "disappeared": [] },
      "prefix":    { "appeared": [], "disappeared": [] }
    }
  ],
  "unreachable": { "appeared": [ /* 不可触发命令（含原因） */ ], "disappeared": [] }
}
```

- **绑定条目**：`commandId, name, contextPath（来源路径）, sequenceLabel, shortestLabel（最短触发输入）, state, draftOp（草案来源标记）`；
- **冲突条目**：与 `/api/review` 的 conflicts 结构一致，另附 `goalId`（参与命令集合的稳定身份），
  参与方按命令 id 排序并各带来源路径与最短触发输入。

草案非法（序列不合法、命令/上下文不存在、重复操作、改已删除命令等）时返回 `400` 与错误说明，不产生任何副作用。

`/api/regression-suite` 返回结构：

```jsonc
{
  "generatedAt": "…",
  "stats": {
    "leafCount": 2,                 // 叶子上下文总数
    "candidateCount": 2,            // 覆盖了至少一个目标的候选叶子数
    "selectedContextCount": 2,      // 套件入选叶子数（精确最小）
    "commandCount": 19,
    "triggerableCommandCount": 18,  // 至少在一个叶子可触发的命令
    "coveredCommandCount": 18,
    "unreachableCommandCount": 1,   // 任何叶子都无法触发（不计入覆盖）
    "duplicateConflictCount": 1,
    "prefixConflictCount": 5,
    "inputSequenceCount": 25,       // 套件用例输入序列总数
    "coverableGoalCount": 24,       // 可触发命令 + 冲突目标
    "coveredGoalCount": 24
  },
  "suite": [
    {
      "contextId": "ctx-code",
      "contextPath": "App / Editor / Code Editor",
      "inputs": [
        { "sequenceLabel": "G", "sequenceTokens": ["g"], "duplicate": false,
          "expectedCommands": [ { "commandId": "…", "name": "…", "contextPath": "…" } ] }
      ],
      "expectedConflicts": [ /* 与 /api/review 的 conflicts 结构一致 */ ],
      "coveredGoals": [ "cmd:…", "dup:…", "pre:…" ]
    }
  ],
  "candidates": [ { "contextId": "…", "contextPath": "…", "goalCount": 16, "selected": true } ],
  "unreachableCommands": [
    { "commandId": "…", "name": "…", "contextPath": "…", "sequenceLabel": "G",
      "reason": "序列「G」在所属上下文子树下的全部 2 个叶子上下文中均被更近祖先的同序列绑定覆盖…",
      "shadowedBy": [ { "contextId": "…", "contextPath": "…" } ] }
  ]
}
```

## 目录结构

```
.
├── Dockerfile                # 多阶段构建（构建前端 → 仅生产依赖运行）
├── docker-compose.yml        # 一条命令启动，端口 3000，命名卷持久化
├── server/
│   ├── src/
│   │   ├── index.js          # Express 入口、API（含沙盒预演）、静态托管
│   │   ├── engine.js         # 核心规则：最近祖先/冲突/逐键模拟/回归套件（精确集合覆盖）/沙盒预演
│   │   ├── store.js          # JSON 文件持久化 + 校验
│   │   └── seed.js           # 初始演示数据
│   └── test/engine.test.js   # 引擎单测
└── client/
    ├── src/
    │   ├── App.jsx
    │   ├── api.js
    │   ├── styles.css
    │   └── components/       # 上下文树 / 命令面板 / 绑定与冲突 / 逐键模拟器 / 回归套件 / 变更沙盒
    └── vite.config.js
```
