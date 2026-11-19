# vendor — 第三方库与字体（本地化）

全部来自公网 CDN，已下载到本地，离线可用。勿手工修改，更新请重新下载对应版本。

| 文件 | 来源 | 版本 |
|---|---|---|
| vue.global.prod.js | cdn.jsdelivr.net/npm/vue@3 | Vue 3 运行时（与 kit.js 注释一致） |
| kit.css / kit.js | github.com/imohuan/ui-kit | UI 组件库（Vue 3 + Material 3 黑白风格） |
| material-symbols-outlined.woff2 | fonts.gstatic.com | Material Symbols v385，可变字重 100–700 |
| jetbrains-mono-latin.woff2 | fonts.gstatic.com | JetBrains Mono v24 latin，400/500 |
| fonts.css | 生成 | 上面两个字体的 @font-face 规则（src 指向本地 woff2） |

字体子集说明：JetBrains Mono 只含 latin 区段（页面用于坐标数字/编号）；
Material Symbols 为全量图标字体，图标名通过 ligature 渲染。
