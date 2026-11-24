# Free Token Gateway — 配置说明

## 作用

本机策展型 LLM 网关（默认端口 `20188`）：

1. **商家目录**（静态 `data/providers.json`）：列出常见免费 / 试用 / 廉价 API 入口与注册链接  
2. **我的连接**：你把各家 Key 回填后，网关按策略轮换；遇 429/额度类错误会冷却并切下一家  
3. **接线**：Deploy 启用服务后，临时把 DSH / OpenCode 指向本网关；停止后恢复原配置  

密钥只保存在本工具 `home/config.json`，不会写入 Agent 配置。

- UI：`http://127.0.0.1:20188/`
- OpenAI：`/v1/chat/completions`、`/v1/models`
- Anthropic（DSH）：`/v1/messages`、`/models`

## 步骤

1. 在 Deploy「运营 → 工具箱」安装并**启动** Free Token Gateway。
2. 点**配置**，打开本机配置页（与 CMS/CRM 同款顶级窗口）。
3. **商家目录**：点「去注册」到官网拿免费/试用 Key，再「填入密钥」保存连接。
4. **策略与状态**：默认模型选 `cizhenyu/auto-text`（自动轮换）；确认轮换模式后点「保存策略并重新接线」。
5. **重新打开** DSH / OpenCode（已开的窗口不会自动切换）。
   - 日常选 **cizhenyu/auto-text**：一家额度/429 时网关在同请求内换连接并改写上游模型。
   - 看图选 **cizhenyu/auto-vision**（有 VL 上游时才注入）；若 auto-text 请求里带图，会升到视觉池。
   - 视觉池按**单模型**能力过滤（例如 Groq 只有 Scout 进视觉池，不会把整家文本模型塞进去）。
   - 「策略与状态」可看**最近成功走了哪家**、模型级冷却、成功率；同档可略偏好更稳的上游。
   - 钉死物理模型 id：只换同名模型的 Key，不跨模型改写。
   - DSH：接线写入 `llm-deepseek.models`；OpenCode：写入 `opencode.json` provider。Anthropic `/v1/messages` 路径会保留 image 块。
6. 用完后在工具箱**停止服务**，Agent 模型配置回退。

## 维护策展目录

编辑工具源码中的 `data/providers.json`（安装/更新后同步到用户副本）。下一期可改为外部信息源或接口；当前刻意保持静态可维护。

## 注意

- 修改端口后需重启网关进程。
- 服务异常退出时，Deploy 下次检测会尝试恢复 Agent 原模型配置。
- 「免费」取决于商家政策，本工具不保证第三方额度。
