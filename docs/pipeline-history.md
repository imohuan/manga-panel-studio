# 把 CLI 动作写进画布历史（pipeline 记录）

这份文档讲清楚一件事：**怎么让一条命令行操作也出现在右侧「历史」面板里**。
以后想加新的记录类型，照着这里做即可。

## 一、历史记录长什么样

每个会话的历史存在 `sessions/<会话>/history/ops.json`，核心字段：

| 字段 | 含义 | 例子 |
| --- | --- | --- |
| `id` | 自动生成，`时间戳-随机` | `1795147733658-98fi` |
| `ts` | ISO 时间，自动生成 | `2026-11-20T04:08:53.658Z` |
| `kind` | 类型，决定图标和筛选归类 | `ocr` / `box-del` / `pipeline-ocr` |
| `by` | 谁触发的 | `ui` / `cli` |
| `page` | 关联页号 | `00005` |
| `summary` | 历史卡片上那一行字 | `OCR 排队 1 页（后台识别中）` |
| `input` / `output` | 输入输出图（可为 null） | `{image: null, box: null}` |
| `data` | 自定义细节，前端展开后渲染 | `{scope:'pipeline', pages:[...]}` |

写入统一走 `canvas.mjs` 的 `appendOp(session, op)`：它负责补 `id` / `ts`、
写文件、并通过 SSE 广播 `op` 事件——**所以前端不需要刷新就能看到新记录**。

## 二、这次新增的两个类型

| kind | 图标 | 卡片文案 | data |
| --- | --- | --- | --- |
| `pipeline-ocr` | `low_priority` | `OCR 排队 N 页（后台识别中）` | `{scope:'pipeline', pages:[页号...]}` |
| `pipeline-next` | `page_info` | `流水线取页 -> 00001（转校验/写 md）` | `{scope:'pipeline', pages:['00001'], remaining:剩余页数}` |

效果：agent 每排一批 OCR、每取一页往下做，历史面板都会多一条，
展开能看到具体页号标签。这样流水线节奏全程可追溯。

## 三、加一条新记录的完整步骤

### 1. 服务端加一个写入口（推荐）

在 `server/canvas.mjs` 的路由里接收请求，校验参数后调用 `appendOp`：

```js
m = p.match(/^\/api\/session\/([^/]+)\/pipeline$/);
if (m && req.method === 'POST') {
  const d = await body(req);
  const kind = String(d.kind || '');
  if (!['pipeline-ocr', 'pipeline-next'].includes(kind)) {
    return send(res, 400, { error: 'kind 不支持' });
  }
  const op = appendOp(m[1], {
    kind, by: d.by || 'cli', page: d.page || null,
    summary: '一句话概括这次操作',
    input: { image: null, box: null, scope: 'pipeline' },
    output: { image: null, count: d.pages?.length ?? null },
    data: { scope: 'pipeline', pages: d.pages || [], remaining: d.remaining ?? null },
  });
  return send(res, 200, { ok: true, opId: op.id });
}
```

要点：

- `kind` 要有白名单，避免前端拿到未知类型后渲染出错；
- `summary` 是卡片上唯一显示的文字，要能一眼看懂；
- 不涉及图片时 `input.image` / `output.image` 传 `null`；
- 返回 `opId` 方便调用方确认写成功。

### 2. CLI 侧调用（失败不阻塞）

```python
def record_pipeline(base, session, kind, page=None, pages=None, remaining=None):
    try:
        api(base, 'POST', f'/api/session/{session}/pipeline',
            json={'kind': kind, 'page': page, 'pages': pages, 'remaining': remaining})
    except Exception:
        pass   # 历史只是可视化，写不上不影响主流程
```

关键点：**一定吞掉异常**。历史记录失败不该让 OCR 任务失败。

### 3. 前端加图标和筛选

`public/canvas.js`：

```js
ICON['pipeline-ocr'] = 'low_priority';
ICON['pipeline-next'] = 'page_info';
```

如果需要在筛选条里单独归类，就在 `filteredHistory` 加一个分支：

```js
if (histFilter.value === 'pipeline') {
  return history.value.filter((o) => String(o.kind).startsWith('pipeline-'));
}
```

### 4. 前端展开区渲染细节（可选）

`public/panel.html` 里按 `kind` 前缀加一块：

```html
<div v-if="String(o.kind).startsWith('pipeline-')">
  <div>{{ o.kind === 'pipeline-ocr' ? '本轮排队页' : '流水线取页' }}</div>
  <span v-for="pg in (o.data.pages || [])" :key="pg">{{ pg }}</span>
</div>
```

不加也能正常显示卡片，只是展开区只有一句 summary。

## 四、验证方法

```powershell
# 1. 跑一次会产生记录的命令
python skills/manga-panel-studio/scripts/canvas_cli.py ocr demo --pages 00001

# 2. 直接看磁盘上的历史
node -e "const d=require('C:/Users/Administrator/.manga-panel-studio/sessions/demo/history/ops.json');" +
  "console.log((d.ops||[]).filter(o=>o.kind.startsWith('pipeline')).map(o=>o.summary))"

# 3. 打开画布历史面板确认（应实时出现，无需刷新）
#    http://127.0.0.1:7788/?s=demo
```

## 五、已有类型对照

| kind | 来源 | 说明 |
| --- | --- | --- |
| `ocr` / `detect` | 画布任务队列 | 整页/区域识别、找框 |
| `ocr-box` | 框内识别 | 单框识别 |
| `box-add` / `box-del` / `box-edit` / `box-clear` / `box-erase` | 手动或 CLI 改框 | 带框坐标，前端现场画红框 |
| `box-reorder` | CLI `reorder` | 按 md 台词顺序重排 |
| `ai-check` | CLI `view` | AI 读图校验，含回答与提示词 |
| `check-audio` / `check-characters` | CLI 自检 | 静态度量结果 |
| `pipeline-ocr` / `pipeline-next` | CLI 流水线 | 本次新增 |

## 六、注意事项

- **所有写入都走 HTTP 接口**，不要直接改 `ops.json`，否则不会广播、前端不刷新；
- `data` 里不要塞大图，图片走 `input.image` / `output.image` 的哈希文件名机制；
- `kind` 前缀会影响前端渲染（例如 `box-` 会被当改框、`check-` 会被当检查），
  新类型请用独立前缀，避免被误渲染。
