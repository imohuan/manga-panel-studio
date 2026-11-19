# 多人协作规则（必须遵守）

这个项目会有多个对话同时修改。它们共用同一个目录 `I:\comic-canvas`。
如果大家随手改同一份文件，就会出现「A 改的代码被 B 覆盖」的反复修复。
所以定下下面的规矩。任何对话进入本项目，先读完这一页。

## 1. 三个「热文件」

- `public/canvas.js`
- `public/panel.html`
- `public/index.html`

它们很大，而且好几个任务都要改。**同一时间只允许一个对话改。**

## 2. 改之前先认领

在项目根目录运行：

```powershell
node scripts/coord.mjs status
node scripts/coord.mjs claim public/canvas.js --owner "右侧面板 UI 优化"
```

- `status` 能看到每个热文件现在归谁、改了多久。
- `claim` 成功才能动手。被别人占用时会直接失败，**这时不要硬改**：
  先做只读的调研、写方案，或者去改没人占用的文件。
- 改完并确认能跑，再 `release`：

```powershell
node scripts/coord.mjs release public/canvas.js
```

## 3. 绝对不要做的事

1. **不要删掉或还原「看不懂的代码」。** 看到不认识的函数、变量、样式，先查：
   `git log --oneline -10 -- <文件>`，再看 `docs/coordination.md` 的登记表。
   它很可能是另一个对话刚加的，删掉就等于抹掉别人的成果。
2. **不要整文件重写。** 一律用小块 `apply_patch`，只改自己负责的那一段。
   整文件写回会吞掉别人在这期间的修改。
3. **不要用 `git checkout --`、`git restore`、`git reset --hard`、`git stash pop`
   处理不属于你的文件。**
4. **不要用 `git add -A` / `git add .`。** 只提交自己改的文件。
5. **不要让两个人同时改同一函数。** 需要动别人负责的区域时，先发消息商量，
   或者等对方 `release` 之后再接手。

## 4. 改之前必做

1. 运行 `node scripts/coord.mjs verify public/canvas.js`。
   如果提示「文件在你认领之后被改过」，说明有人动过，**必须重新读这一段**再打补丁。
2. 用 `apply_patch` 打补丁。补丁的上下文行要包含别人刚加的代码，
   这样冲突会直接失败，而不是悄悄覆盖。

## 5. 收尾

- 每完成一个能独立运行的小功能，就提交一次，只加自己的文件：

  ```powershell
  git add public/canvas.js
  git commit -m "[画布] 说明这次改了什么"
  ```

- 提交后别人能看到你的成果，就不会误以为「代码没生效」而重复修改。
- 前端改完刷新浏览器（Ctrl+F5）验证；后端改完要重启对应服务。
- 最后 `release` 文件，并在 `docs/coordination.md` 里勾掉自己的任务。

## 6. 遇到冲突怎么办

如果发现自己的修改不见了：

1. 先 `git log --oneline -10 -- <文件>` 看有没有别人的提交。
2. 再 `git diff` 看现在的实际内容。
3. 确认是别人覆盖的，**不要自己再覆盖回去**。记下丢失的内容，
   在 `docs/coordination.md` 里登记，然后通知对应对话。

历史的整体快照在 git tag `coord-snapshot-20261119`，可以作为找回参考。

## 7. 共享服务：别随手重启

所有对话共用同一套正在跑的服务：

- 画布：`node server/canvas.mjs`，端口 **7788**
- 识别：`I:\manga-image-translator\py310\python.exe server/ocr_service.py --port 5009 --use-gpu`

**重启前先认领**，否则会打断别人正在做的测试：

```powershell
node scripts/coord.mjs claim runtime:ocr --owner "历史记录 图片保存"
# ... 重启并测试完 ...
node scripts/coord.mjs release runtime:ocr
```

另外：

- 前端（`public/*`）改完只要 **Ctrl+F5 刷新浏览器**就生效，不用重启画布服务。
  别为了「让改动生效」去重启 Node，那会打断别人。
- 端口 7788 / 5009 上已经有进程时，**先确认是谁在跑**，不要直接杀：
  `Get-NetTCPConnection -LocalPort 7788 -State Listen | Select OwningProcess`
- 如果你发现端口被占，而自己没在认领状态里，说明是别人的实例，直接用它测试即可。

## 8. 怎么判断「我改的到底生效没有」

按这个顺序查，不要一上来就重写代码：

1. 前端（`public/*`）：Ctrl+F5 硬刷新。看到的还是旧的，就用
   `Invoke-WebRequest http://127.0.0.1:7788/` 看服务器返回的 HTML 里有没有你那段。
   有 = 已经生效，是你没刷新；没有 = 文件没写进去或被覆盖，`git diff` 查。
2. 后端 Node（`server/*.mjs`、`server/*.js`）：**必须重启** `node server/canvas.mjs`。
   `node scripts/coord.mjs status` 最后一段会直接告诉你「跑的是旧代码」。
3. Python 识别服务（`server/*.py`）：同样必须重启，并确认加载的是本项目文件，
   不是 `I:\manga-image-translator` 下的同名旧文件。
4. 代码在、服务也新，却仍然不对 → 这时才怀疑逻辑问题，用 systematic-debugging。
