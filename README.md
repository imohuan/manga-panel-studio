# 漫画画布（comic-canvas）

无限画布形式的漫画 OCR 校对工具：图片平铺在画布上，框跟随图片缩放平移，
Agent 通过 HTTP 改框，前端用 SSE 实时刷新。

## 目录结构

    start.bat            一键启动（画布 7788 + OCR 5009）
    server              后端服务
      canvas.mjs         画布服务（Node，7788）
      tool_routes.js     设置界面 + 音频管理路由（合并自 tools/）
      tools_helpers.js   设置/音频的后端逻辑（settings.json、豆包、characters）
      ocr_service.py     OCR 服务（Python，5009，mask-column 算法）
      mask_column_ocr.py 核心算法（检测→切列→OCR）
      draw_boxes.py      历史输出图绘制
      render_check.py    检查图渲染
    public              前端（原生 JS，无构建）
      index.html         主页面
      settings.html      设置界面（主页面顶栏按钮打开，可全屏）
      audio.html         音频管理界面（同上）
      canvas.js          画布逻辑
      panel.html         右侧面板模板
      lightbox.js        全屏预览
      render.html        检查图预览页
      vendor            第三方库与字体（本地化，离线可用）
    sessions            画布数据（一个会话一个文件夹）
    docs                文档
    test                端到端测试

## 启动

    start.bat

或分别手动：
    node server\canvas.mjs                                    # 画布 http://127.0.0.1:7788
    I:\manga-image-translator\py310\python.exe server\ocr_service.py --port 5009 --use-gpu

首次启动时 OCR 要加载模型，/health 可能 1-3 分钟才通，属正常现象，不要重复启动。
start.bat 会自动拉起两个服务并打开浏览器；画布窗口关掉即停止画布服务。
