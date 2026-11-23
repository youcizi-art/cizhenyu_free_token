# Free Token Gateway — 配置说明

## 作用

本工具在本机启动 OpenAI 兼容网关（默认端口 `20188`）：

- UI：`http://127.0.0.1:20188/`
- API：`http://127.0.0.1:20188/v1`

在网关 UI 中配置上游（任意 OpenAI 兼容 `baseUrl` + API Key）。可选把 CMS「AI 设置」里的 providers JSON 导入为上游。

Deploy 启用本工具服务后，会**临时**把 DSH / OpenCode 的聊天模型入口改到本网关；关闭服务后**恢复**原配置。上游密钥只存在本工具 `home/config.json`，与 Agent 原配置隔离。

## 步骤

1. 在 Deploy「运营 → 工具箱」安装并启动 **Free Token Gateway**。
2. 点**配置**：打开本机配置页（与 CMS/CRM 同款顶级窗口）。
3. **步骤 1** 添加上游：填写 Base URL（如 `https://api.deepseek.com/v1`）、API Key、模型 id（如 `deepseek-chat`）。
4. **步骤 2** 选择默认模型，点「保存并应用到 Agent」。
5. **重新打开** DSH / OpenCode（已运行的窗口不会自动切换）。
6. 用完后在工具箱**停止服务**，Agent 模型配置回退。

## 注意

- 修改端口后需重启网关进程。
- 服务异常退出时，Deploy 下次检测会尝试恢复 Agent 原模型配置，避免一直指向死掉的 localhost。
- 「免费」取决于你配置的上游；本工具本身不收费，也不保证第三方免费额度。
