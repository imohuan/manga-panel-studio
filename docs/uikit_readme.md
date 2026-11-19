# kit-ui-js

M3 黑白极简风格的 **Vue 3 组件库**，零构建、可直接通过 CDN 引入，专为 AI Agent 生成页面而设计。

风格参考自 [imohuan/axui](https://github.com/imohuan/axui) 与 Material Design 3（主色纯黑、灰阶表面层级、Geist / JetBrains Mono 字体、Material Symbols 图标）。

> 所有组件 `size` 严格统一：**sm=20px / md=24px / lg=28px**。

---

## 快速开始（CDN）

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <!-- 1. 字体与图标 -->
  <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" rel="stylesheet">
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <link href="https://cdn.jsdelivr.net/npm/@fontsource/geist@5.2.9/400.css" rel="stylesheet">
  <link href="https://cdn.jsdelivr.net/npm/@fontsource/geist@5.2.9/600.css" rel="stylesheet">
  <!-- 2. 组件样式 -->
  <link rel="stylesheet" href="https://unpkg.com/kit-ui-js@latest/kit.css">
</head>
<body class="bg-surface-container-low">
  <div id="app" v-cloak>
    <kit-button icon="add">添加</kit-button>
    <kit-input v-model="name" placeholder="请输入名称"></kit-input>
    <kit-select v-model="model" :options="models" placeholder="选择模型"></kit-select>
  </div>

  <!-- 3. Vue + 组件库 -->
  <script src="https://cdn.jsdelivr.net/npm/vue@3/dist/vue.global.prod.js"></script>
  <script src="https://unpkg.com/kit-ui-js@latest/kit.js"></script>
  <script>
    const app = Vue.createApp({
      setup() {
        const name = Vue.ref('');
        const models = [
          { label: 'qwen-max', value: 'qwen-max' },
          { label: 'glm-4', value: 'glm-4' },
        ];
        const model = Vue.ref('');
        return { name, models, model };
      },
    });
    app.use(window.UIKit);   // 注册全部组件 + $notify / $confirm / $dialog
    app.mount('#app');
  </script>
</body>
</html>
```

**其他 CDN：**

```
https://unpkg.com/kit-ui-js@latest/kit.css
https://unpkg.com/kit-ui-js@latest/kit.js
https://cdn.jsdelivr.net/npm/kit-ui-js@latest/kit.css
https://cdn.jsdelivr.net/npm/kit-ui-js@latest/kit.js
```

**加载顺序必须**：`vue.global` → `kit.js` → 业务 script（kit.js 依赖 Vue 存在）。

### 引入方式（三选一）

| 场景 | 方式 |
|---|---|
| HTML 单页（默认推荐） | CDN：unpkg / jsdelivr 引入 `kit.css` + `kit.js` |
| Vite / Webpack 项目 | `npm install kit-ui-js`，`import 'kit-ui-js/kit.css'` + `app.use(UIKit)` |
| 已有 vue.global 单页 | 仅引入 kit.js，`app.use(window.UIKit)` |

```bash
npm install kit-ui-js
```

```js
import Vue from 'vue';
import 'kit-ui-js/kit.css';
import UIKit from 'kit-ui-js';

const app = Vue.createApp({ ... });
app.use(UIKit);
app.mount('#app');
```

---

## 全局注册内容

`app.use(window.UIKit)` 一次性注册：

- **22+ 全局组件**：`KitButton` `KitIconButton` `KitInput` `KitTextarea` `KitSelect` `KitCheckbox` `KitRadio` `KitSwitch` `KitSlider` `KitChip` `KitBadge` `KitStatusDot` `KitField` `KitSegmented` `KitTagInput` `KitDialog` `KitConfirm` `KitDropdown` `KitTabs` `KitCard` `KitEmpty` `KitAlert` `KitSkeleton` `KitProgress`
- **全局属性**：`$notify`（Toast）/ `$confirm`（Promise 确认框）/ `$dialog`（程序化弹窗）
- **指令**：`v-tooltip="'提示文字'"`

---

## 组件清单与用法

### 表单控件

```html
<!-- 按钮：filled(默认) / outlined / text / tonal / error；size: sm|md|lg -->
<kit-button>保存</kit-button>
<kit-button variant="outlined" icon="add">添加</kit-button>
<kit-button size="sm">小</kit-button>
<kit-button loading>加载中</kit-button>
<kit-button disabled>禁用</kit-button>

<!-- 输入框：图标 / 前缀 / 后缀 / 密码 / 错误态 -->
<kit-input v-model="a" placeholder="名称"></kit-input>
<kit-input v-model="b" icon="search" placeholder="搜索..."></kit-input>
<kit-input v-model="c" prefix="PORT" mono></kit-input>
<kit-input v-model="d" suffix="GB"></kit-input>
<kit-input v-model="pwd" type="password" password-toggle></kit-input>
<kit-input v-model="bad" invalid></kit-input>

<!-- 文本域 -->
<kit-textarea v-model="ta" rows="3" placeholder="多行内容"></kit-textarea>

<!-- 下拉选择：单选 / 多选 / 可搜索 / 键盘导航 -->
<kit-select v-model="sel" :options="[{label:'qwen-max',value:'qwen-max'}]" placeholder="请选择"></kit-select>
<kit-select v-model="arr" :options="opts" multiple></kit-select>
<kit-select v-model="sel2" :options="opts" searchable search-placeholder="搜索..."></kit-select>
<!-- 兼容旧用法 -->
<kit-select v-model="sel3"><option value="a">A</option></kit-select>

<!-- 其他 -->
<kit-checkbox v-model="cb" label="启用"></kit-checkbox>
<kit-radio v-model="r" value="quick" label="快速"></kit-radio>
<kit-switch v-model="sw" label="自动保存"></kit-switch>
<kit-slider v-model="n" min="1" max="20"></kit-slider>
<kit-segmented v-model="seg" :options="[{label:'快速',value:'quick',icon:'bolt'}]"></kit-segmented>
<kit-tag-input v-model="tags" placeholder="回车添加标签"></kit-tag-input>
```

### 表单字段（label + hint + error）

```html
<kit-field label="API Key" icon="key" required hint="用于鉴权">
  <kit-input v-model="key" type="password" password-toggle></kit-input>
</kit-field>
<kit-field label="模型" icon="smart_toy" error="必填项">
  <kit-select v-model="model" :options="opts"></kit-select>
</kit-field>
```

### 反馈

```html
<!-- 弹窗 -->
<kit-dialog v-model="open" title="接口配置" icon="settings" size="lg">
  <p>内容</p>
  <template #footer>
    <kit-button variant="outlined" @click="open=false">取消</kit-button>
    <kit-button @click="open=false">确定</kit-button>
  </template>
</kit-dialog>

<!-- 确认框 -->
<kit-confirm v-model="show" type="danger" title="删除任务" message="确定删除？"
  confirm-text="删除" cancel-text="取消" @confirm="onDelete"></kit-confirm>

<!-- 程序化确认（Promise） -->
<script>
  const ok = await this.$confirm({ title: '删除', message: '确定？', type: 'danger', confirmText: '删除' });
  if (ok) { /* 用户点了确认 */ }
</script>

<!-- Toast 通知 -->
<script>
  this.$notify.info('信息');        // 或 this.$toast.info()
  this.$notify.success('成功');
  this.$notify.warning('警告');
  this.$notify.error('失败');
  this.$notify.show({ message: '5秒后消失', duration: 5000 });
</script>

<!-- 程序化弹窗 -->
<script>
  this.$dialog({ title: '提示', content: '<p>HTML 内容</p>', size: 'sm' });
</script>

<!-- Tooltip：组件 / 指令 -->
<kit-tooltip text="顶部提示"><kit-button>悬停</kit-button></kit-tooltip>
<button v-tooltip="'指令提示'">Hover me</button>

<!-- 下拉菜单 -->
<kit-dropdown v-model="open" :items="[
  { label: '重命名', value: 'rename', icon: 'edit' },
  { label: '删除', value: 'delete', icon: 'delete', danger: true },
]" @select="onMenuSelect">
  <template #trigger><kit-button variant="outlined">更多操作</kit-button></template>
</kit-dropdown>
```

### 数据展示

```html
<kit-card title="任务概览" icon="monitoring" elevated>
  <div class="space-y-3">
    <kit-progress :value="72"></kit-progress>
    <kit-skeleton width="100%" height="14px"></kit-skeleton>
  </div>
</kit-card>

<table class="kit-table">
  <thead><tr><th>模型</th><th>状态</th><th>操作</th></tr></thead>
  <tbody>
    <tr>
      <td class="kit-table__mono">qwen-max</td>
      <td><span class="inline-flex items-center gap-1"><kit-status-dot status="ok"/>成功</span></td>
      <td><kit-badge variant="ok">快速</kit-badge></td>
    </tr>
  </tbody>
</table>

<kit-empty icon="inbox" title="暂无任务" desc="添加模型后自动生成任务"></kit-empty>
<kit-alert type="warning">磁盘空间不足</kit-alert>
<kit-tabs v-model="tab" :tabs="[{label:'响应',value:'response',icon:'chat'}]"></kit-tabs>
```

---

## 设计规范（Agent 生成页面时必须遵守）

### 布局模式

```
┌──────────────────────────────────────────────┐
│ Header: bg-surface-container-lowest border-b │
│   左: 图标+标题 (text-sm font-semibold)       │
│   右: 操作按钮 (kit-btn--outlined)            │
├──────────────┬───────────────────────────────┤
│ 侧栏 w-52    │ 主内容区                       │
│ bg-white     │ flex-1 overflow-y-auto         │
│ 导航项:      │ 内容 max-w-4xl mx-auto p-6      │
│ 图标+文字    │                                │
└──────────────┴───────────────────────────────┘
```

- 页面根：`h-screen flex flex-col overflow-hidden`，**禁止 body 滚动**
- 内容区滚动：`flex-1 overflow-y-auto`（右侧单独滚动）
- 页面背景：`bg-surface-container-low`；卡片/弹窗：`bg-surface-container-lowest border border-outline-variant`

### 颜色（语义 token，禁止硬编码）

| token | 值 | 用途 |
|---|---|---|
| `primary` | `#000000` | 主按钮、开关、强调文字 |
| `surface-container-low` | `#f3f3f4` | 输入框底色、悬停 |
| `surface-container-lowest` | `#ffffff` | 卡片、弹窗、侧栏 |
| `outline-variant` | `#c8c5ca` | 边框、分隔线 |
| `on-surface-variant` | `#47464a` | 次要文字 |
| `error` / `ok` / `warning` / `info` | 语义色 | 状态 |

工具类：`text-primary` `text-on-surface-variant` `text-outline` `bg-surface-container-low` `border border-outline-variant` `rounded-md` 等。

### 尺寸体系

- 控件高度：**sm=20px md=24px lg=28px**，同 size 严格对齐（按钮/输入框/下拉/开关）
- 圆角：控件 4px（`rounded-md`），卡片/弹窗 8px（`rounded-xl`）
- 字号：正文 12px（`text-xs`），标签 10-11px，标题 14px
- 间距：控件内 padding 8-10px，区块间距 16px（`p-4`），卡片 body 16px

### 尺寸选择

| 场景 | size |
|---|---|
| 表格行内、密集工具栏 | `sm` (20px) |
| 表单默认、弹窗内 | `md` (24px) —— **默认，通常省略** |
| 页面主操作、突出按钮 | `lg` (28px) |

### 图标

Material Symbols Outlined，统一 18px（`<span class="material-symbols-outlined">icon_name</span>`），按钮内 14px。常用：`settings` `close` `add` `search` `info` `warning` `error` `check_circle` `expand_more` `delete` `edit` `download`。

### 交互规范

- 弹窗：遮罩点击关闭（`@click.self`）+ `v-model` 控制
- 下拉：点击外部 / ESC 关闭（KitDropdown 已内置）
- 通知：`$notify` 顶部居中，自动消失
- 过渡：100-200ms，主按钮 hover `opacity-90`

---

## Agent 决策规则

### 该用什么组件

| 需求 | 用 | 不要用 |
|---|---|---|
| 按钮 | `<kit-button>` | 原生 `<button>`（除非纯图标行内） |
| 图标按钮 | `<kit-icon-button icon="...">` | 自己摆 span |
| 文本输入 | `<kit-input>` | 原生 input |
| 密码 | `<kit-input type="password" password-toggle>` | 手写可见切换 |
| 多行文本 | `<kit-textarea>` | 原生 textarea |
| 下拉选择 | `<kit-select :options="[...]">` | 原生 select（外观不一致） |
| 多选 | `<kit-select multiple>` | checkbox 堆叠 |
| 开关 | `<kit-switch v-model>` | checkbox 冒充开关 |
| 确认操作 | `$confirm()` 或 `<kit-confirm>` | window.confirm |
| 通知 | `$notify.success(...)` | 手写 toast |
| 弹窗 | `<kit-dialog>` 或 `$dialog()` | 自绘 overlay |
| 下拉菜单 | `<kit-dropdown :items="[...]">` | 手写定位浮层 |
| 状态展示 | `<kit-status-dot>` / `<kit-badge>` | 手画圆点 |
| 空状态 | `<kit-empty>` | 手写空 div |

### 布局规则

- **页面骨架**：`h-screen flex flex-col overflow-hidden`（根）→ header（`flex-shrink-0`）→ 主体（`flex-1 flex overflow-hidden min-h-0`）
- **左侧栏**：`w-52 flex-shrink-0 bg-surface-container-lowest border-r border-outline-variant`
- **右侧内容**：`flex-1 overflow-y-auto min-w-0` ← **只有这里滚动**
- **内容容器**：`max-w-4xl mx-auto p-6`
- 卡片栅格：kit.css 无 grid 工具类时用 `flex flex-wrap gap-3` + 每卡 `flex-1 min-w-52`

### 状态与反馈

- 耗时操作按钮：`<kit-button loading>`
- 表单校验失败：`<kit-input invalid>` + `<kit-field error="...">`
- 操作成功/失败：`$notify.success/error(...)`，**不要在页面内嵌成功提示条**
- 删除等危险操作：先 `$confirm({ type:'danger', confirmText:'删除' })` 再执行

### 命名与代码风格

- 组件标签统一 kebab-case：`<kit-button>` `<kit-select>`
- `v-model` 绑定响应式：`Vue.ref()` / `Vue.reactive()`
- 图标名用 Material Symbols 官方名（`settings` `add` `close` `expand_more` ...），不要 invent 图标名
- 等宽场景（模型名、代码、数值）加 `mono` 属性或 `font-mono` 类
- 颜色只用 token 类（`text-primary` 等），**禁止硬编码 hex**

---

## 常见页面模板

### 设置/配置页（表单）

```html
<div class="max-w-3xl mx-auto p-6 space-y-4">
  <kit-card title="接口配置" icon="settings">
    <div class="kit-form">
      <div class="kit-form-row">
        <kit-field label="Base URL" icon="link" required>
          <kit-input v-model="cfg.url" mono placeholder="https://api.example.com/v1"></kit-input>
        </kit-field>
        <kit-field label="API Key" icon="key" required>
          <kit-input v-model="cfg.key" type="password" password-toggle></kit-input>
        </kit-field>
      </div>
      <div class="kit-form-row">
        <kit-field label="模型" icon="smart_toy" required>
          <kit-select v-model="cfg.model" :options="models" placeholder="请选择"></kit-select>
        </kit-field>
        <kit-field label="并发数" icon="speed">
          <kit-slider v-model="cfg.concurrency" min="1" max="20"></kit-slider>
        </kit-field>
      </div>
      <div class="kit-form-actions">
        <kit-button variant="outlined" @click="reset">重置</kit-button>
        <kit-button icon="save" @click="save">保存</kit-button>
      </div>
    </div>
  </kit-card>
</div>
```

### 控制台/任务列表（左侧栏 + 右侧内容）

```html
<div class="h-screen flex flex-col overflow-hidden">
  <header class="flex-shrink-0 bg-surface-container-lowest border-b border-outline-variant px-6 py-3 flex items-center justify-between">
    <div class="flex items-center gap-2">
      <span class="material-symbols-outlined text-primary">travel_explore</span>
      <h1 class="text-sm font-semibold text-primary">任务控制台</h1>
    </div>
    <kit-button variant="outlined" icon="settings" @click="openConfig">配置</kit-button>
  </header>
  <div class="flex-1 flex overflow-hidden min-h-0">
    <!-- 左侧任务列表 -->
    <aside class="w-52 flex-shrink-0 bg-surface-container-lowest border-r border-outline-variant p-2">
      <button v-for="t in tasks" class="kit-list-item w-full" :class="{ 'kit-list-item--active': sel===t.id }"
        @click="sel=t.id">
        <kit-status-dot :status="t.status"></kit-status-dot>
        <span class="font-mono text-xs truncate flex-1">{{ t.model }}</span>
      </button>
    </aside>
    <!-- 右侧详情 -->
    <main class="flex-1 overflow-y-auto min-w-0 p-4">
      <kit-empty v-if="!sel" icon="inbox" title="选择左侧任务查看详情"></kit-empty>
      <template v-else>
        <!-- 详情内容 -->
      </template>
    </main>
  </div>
</div>
```

### 数据表格 + 操作

```html
<kit-card>
  <div class="p-4">
    <table class="kit-table">
      <thead><tr><th>模型</th><th>状态</th><th>用量</th><th class="text-right">操作</th></tr></thead>
      <tbody>
        <tr v-for="t in rows" :key="t.id">
          <td class="kit-table__mono">{{ t.model }}</td>
          <td>
            <span class="inline-flex items-center gap-1 text-xs">
              <kit-status-dot :status="t.status"></kit-status-dot>{{ t.statusText }}
            </span>
          </td>
          <td class="kit-table__mono">{{ t.usage }}</td>
          <td class="text-right">
            <kit-icon-button icon="visibility" size="sm"></kit-icon-button>
            <kit-icon-button icon="close" size="sm" danger @click="remove(t)"></kit-icon-button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</kit-card>
```

---

## 常见坑（Agent 必读）

1. **body 不能滚**：根元素 `h-screen overflow-hidden`，内容滚动用 `overflow-y-auto` 子区域
2. **`v-cloak`**：根元素加 `v-cloak` + `<style>[v-cloak]{display:none}</style>`，避免 FOUC
3. **kit-select 的 options 必须给 value**：`{label, value}`，不要只给字符串数组
4. **kit-dropdown 触发器放 `#trigger` slot**，否则点击不响应
5. **图标名拼错不报错但显示空**：Material Symbols 名称严格（`expand_more` 不是 `expand-more`）
6. **`$confirm`/`$dialog` 是 Promise**：必须 `await` 或在 `.then` 里继续
7. **多选 select 的 v-model 必须是数组**：`Vue.ref([])`
8. **CDN 下 kit.js 依赖全局 Vue**：确保 script 顺序 `vue → kit.js → 业务`
9. **勿用 `vue.global.js` 混 ESM**：统一 `vue.global.prod.js`
10. **控件高度不可局部放大**：不要给某控件单独加 `h-8`/`py-2` 破坏对齐

---

## 验证清单（生成页面后自查）

- [ ] 页面在 1280px 宽无横向溢出
- [ ] 右侧内容区独立滚动，body 不滚
- [ ] 所有按钮/输入框/下拉 height 对齐（md=24px）
- [ ] 颜色全部 token 类，无硬编码 hex
- [ ] 交互：按钮 hover、下拉打开/关闭、弹窗遮罩关闭、toast 自动消失
- [ ] 字体加载：Geist + JetBrains Mono + Material Symbols 无 404

---

## License

MIT © imohuan
