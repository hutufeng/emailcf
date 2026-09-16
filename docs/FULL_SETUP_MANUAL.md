# 多邮箱聚合通知系统完整配置手册

本文档提供从 **Cloudflare 边缘环境部署**、**Telegram Bot 接入** 到 **各大邮箱（QQ / Gmail / Outlook）转发与 Webhook 配置** 的全流程实操指南。

---

## 目录
1. [第一阶段：Telegram Bot 准备](#第一阶段telegram-bot-准备)
2. [第二阶段：Cloudflare 部署与自动更新（二选一）](#第二阶段cloudflare-部署与自动更新二选一)
3. [第三阶段：Cloudflare Email Routing 域名解析与规则](#第三阶段cloudflare-email-routing-域名解析与规则)
4. [第四阶段：QQ 邮箱配置指南（自动转发）](#第四阶段qq-邮箱配置指南自动转发)
5. [第五阶段：Gmail 邮箱配置指南（自动转发 + 可选 Pub/Sub）](#第五阶段gmail-邮箱配置指南自动转发--可选-pubsub)
6. [第六阶段：Outlook 邮箱配置指南（自动转发 + 可选 MS Graph）](#第六阶段outlook-邮箱配置指南自动转发--可选-ms-graph)
7. [第七阶段：端到端验证与故障排查清单](#第七阶段端到端验证与故障排查清单)

---

## 第一阶段：Telegram Bot 准备

### 1. 创建专属 Bot
1. 打开 Telegram，搜索官方 Bot 管理器：`@BotFather`。
2. 发送指令 `/newbot`。
3. 按照提示输入 Bot 的昵称（例如：`MyMailNotifier`）和用户名（必须以 `bot` 结尾，例如：`my_mail_notify_bot`）。
4. 创建成功后，保存下方的 **Token**（形如 `7890123456:AAFlB...`），此即 `TG_BOT_TOKEN`。

### 2. 获取接收通知的个人 Chat ID
1. 在 Telegram 搜索并启动 ID 查询机器人：`@userinfobot`。
2. 点击 Start，机器人会回复你的信息，记录其中的 `Id`（纯数字，例如 `123456789`），此即 `TG_CHAT_ID`。

> **⚠️ 关键必做步骤**：在 Telegram 中找到你刚才新建的 Bot，**主动向它发送一条消息 `/start`**（Telegram 安全策略规定：用户必须先与 Bot 建立对话，Bot 才能主动向用户推送消息）。

---

## 第二阶段：Cloudflare 部署与自动更新（二选一）

你可以根据习惯自由选择以下两种自动部署方式之一：
- **方式一（推荐，最省心）**：直接在 Cloudflare 网页控制台绑定 GitHub 仓库，无需配置 GitHub Secrets。
- **方式二**：使用本项目已内置的 GitHub Actions 工作流进行持续集成部署。

---

### 方式一：Cloudflare 控制台直接网页 Git 部署（推荐）

#### 1. 关联 GitHub 仓库
1. 登录 [Cloudflare 控制台](https://dash.cloudflare.com/)。
2. 在左侧菜单点击 **Workers & Pages** $\rightarrow$ **Overview（概述）**。
3. 点击 **Create application（创建应用程序）** 按钮。
4. 切换到 **Workers** 标签页（或选择 **Connect to Git** / **Workers Builds**）：
   - 点击 **Connect to Git（连接到 Git）**。
   - 授权 Cloudflare 访问你的 GitHub 账号，并从仓库列表中选择 **`hutufeng/emailcf`**。
   - 生产分支选择：`main`。

#### 2. 构建与部署配置
在配置页面中：
- **Project name（项目名称）**：填入 `mail-to-tg`
- **Build command（构建命令）**：`npm install`
- **Deploy command（部署命令）**：`npx wrangler deploy`

#### 3. 配置环境变量与机密 (Variables and Secrets)
在同页面的 **Variables and Secrets** 展开项中（或部署完成后在 Worker 的 `Settings` -> `Variables and Secrets`）：
添加以下两项机密（点击 **Add Secret**）：
- `TG_BOT_TOKEN`：填入第一阶段获得的 Telegram Bot Token
- `TG_CHAT_ID`：填入第一阶段获得的 Telegram 数字 Chat ID

#### 4. 绑定 Workers AI
进入 Worker 项目详情页 $\rightarrow$ **Settings（设置）** $\rightarrow$ **Bindings（绑定）**：
- 点击 **Add** $\rightarrow$ 选择 **Workers AI**。
- **Variable name（变量名称）** 填写：`AI`（必须大写，与代码严格一致）。
- 点击 **Save and deploy（保存并部署）**。

> **效果**：今后无论是本地提交代码 `git push`，还是在 GitHub 网页上修改代码，Cloudflare 会自动捕获变更并在几秒内自动构建发布最新版本！

---

### 方式二：使用 GitHub Actions 自动化部署

如果你更习惯在 GitHub 侧管理 CI/CD，本项目已内置 `.github/workflows/deploy.yml`。

#### 1. 获取 Cloudflare 凭证
1. **Account ID**：
   - 登录 [Cloudflare 控制台](https://dash.cloudflare.com/)，在首页右下角复制 **账户 ID (Account ID)**。
2. **API Token**：
   - 访问 [API 令牌管理页](https://dash.cloudflare.com/profile/api-tokens)。
   - 点击 **创建令牌 (Create Token)**，选用模板 **“编辑 Cloudflare Workers” (Edit Cloudflare Workers)**。
   - 资源范围选择“所有账户/区域”，完成创建并复制令牌，此即 `CLOUDFLARE_API_TOKEN`。

#### 2. 在 GitHub 仓库配置 Secrets
1. 浏览器打开你的 GitHub 仓库密钥配置页：  
   `https://github.com/hutufeng/emailcf/settings/secrets/actions`
2. 点击 **New repository secret**，添加 4 项：
   - `CLOUDFLARE_API_TOKEN`：刚才创建的 Cloudflare API 令牌
   - `CLOUDFLARE_ACCOUNT_ID`：Cloudflare 账户 ID
   - `TG_BOT_TOKEN`：Telegram Bot Token (`789012...`)
   - `TG_CHAT_ID`：你的 Telegram 数字 ID (`123456...`)
3. 添加后，进入仓库 **Actions** 标签页，点击 `Deploy Cloudflare Worker` $\rightarrow$ `Run workflow` 即可完成部署。

---

## 第三阶段：Cloudflare Email Routing 域名解析与规则

### 1. 启用 Email Routing
1. 登录 Cloudflare，进入你的托管域名（例如 `yourdomain.com`）。
2. 左侧导航点击 **Email Routing（电子邮件路由）**。
3. 如果首次使用，点击 **Get started**：
   - 系统会自动提示需要添加 MX 记录和 SPF TXT 记录，点击 **Add records automatically** 一键添加。

### 2. 创建路由分流规则 (Routing Rules)
进入 **Routing rules** 标签页，点击 **Create rule**，按需添加以下规则（将不同邮箱对应到独立别名，便于程序自动贴来源标签）：

| 匹配类型 (Custom address) | 操作 (Action) | 目标 (Destination) | 来源标签识别 |
| :--- | :--- | :--- | :--- |
| `qq-in@yourdomain.com` | **Send to a Worker** | 选择 `mail-to-tg` | 自动识别为 `[QQ 邮箱]` |
| `gmail-in@yourdomain.com` | **Send to a Worker** | 选择 `mail-to-tg` | 自动识别为 `[Gmail]` |
| `outlook-in@yourdomain.com` | **Send to a Worker** | 选择 `mail-to-tg` | 自动识别为 `[Outlook]` |
| `*@yourdomain.com` (Catch-all) | **Send to a Worker** | 选择 `mail-to-tg` | 兜底任意前缀 |

---

## 第四阶段：QQ 邮箱配置指南（自动转发）

QQ 邮箱稳定性高，通过自动转发到 `qq-in@yourdomain.com` 即可秒级送达。

1. 登录 [QQ 邮箱网页版](https://mail.qq.com/)。
2. 点击左上角 **设置** $\rightarrow$ **账户**。
3. 向下滚动找到 **【自动转发】**：
   - 勾选 **“开启”**。
   - 填入转发地址：`qq-in@yourdomain.com`。
   - **必须勾选**：`并在 QQ 邮箱中保留邮件备份`（保障数据永不丢失）。
4. 点击保存，QQ 邮箱会提示“已向该地址发送一封验证邮件”。
5. **打开 Telegram**：因为 Worker 已经上线，你会在几秒钟内收到由 Telegram Bot 推送的验证邮件，里面直接包含**验证链接**，点击即可完成绑定。

---

## 第五阶段：Gmail 邮箱配置指南（自动转发 + 可选 Pub/Sub）

### 方案 A：自动转发（推荐，最稳定简洁）
1. 登录 [Gmail 网页版](https://mail.google.com/)。
2. 点击右上角齿轮图标 $\rightarrow$ **查看所有设置 (See all settings)**。
3. 切换至 **【转发和 POP/IMAP】(Forwarding and POP/IMAP)** 选项卡。
4. 在“转发”模块点击 **添加转发地址 (Add a forwarding address)**。
5. 输入：`gmail-in@yourdomain.com`，点击下一步 $\rightarrow$ 继续。
6. **打开 Telegram**：查收来自 Google 的确认邮件，复制其中的 9 位确认验证码。
7. 回到 Gmail 网页端输入该验证码并确认。
8. 勾选 **【将收到的邮件转发给...】**，并在后方下拉菜单选择 **【在收件箱保留 Gmail 的副本】**。
9. 滚动到页面底部点击 **保存更改 (Save Changes)**。

### 方案 B：Google Cloud Pub/Sub 原生 Webhook（可选低延迟加固通道）
1. 登录 [Google Cloud Console](https://console.cloud.google.com/)，创建项目并启用 **Gmail API** 与 **Cloud Pub/Sub API**。
2. 创建主题：`projects/<PROJECT_ID>/topics/gmail-watch-topic`。
3. 为主题添加权限：主帐号填入 `gmail-api-push@system.gserviceaccount.com`，角色赋予 `Pub/Sub 发布者`。
4. 为主题创建 **推送订阅 (Push Subscription)**，端点填写你的 Worker 域名：  
   `https://<你的worker域名>/webhook/mail`
5. 通过 OAuth 授权调用 `users.watch` 发起推送监听（注：需每 7 天刷新一次）。

---

## 第六阶段：Outlook 邮箱配置指南（自动转发 + 可选 MS Graph）

### 方案 A：自动转发（推荐，一键生效）
1. 登录 [Outlook 网页版](https://outlook.live.com/)。
2. 点击右上角齿轮图标打开 **设置** $\rightarrow$ **邮件** $\rightarrow$ **转发**。
3. 打开 **启用转发 (Enable forwarding)** 开关。
4. 转发电子邮件至：输入 `outlook-in@yourdomain.com`。
5. **勾选**：`保留已转发邮件的副本 (Keep a copy of forwarded messages)`。
6. 点击 **保存**。

### 方案 B：Microsoft Graph Webhook 订阅（可选）
1. 登录 [Microsoft Entra 管理中心 (Azure Portal)](https://portal.azure.com/)。
2. 注册应用，添加 `Mail.Read` 权限并生成 Client Secret。
3. 调用 Graph API 订阅 `/me/mailfolders('inbox')/messages` 变更事件，通知端点指向 Worker。

---

## 第七阶段：端到端验证与故障排查清单

### 1. 验证自测用例
使用第三方邮箱（如手机 139 邮箱、网易邮箱或小号）向你的三个邮箱分别发送测试信件：
- **测试 1（验证码提炼测试）**：
  - 邮件主题：`平台安全验证码`
  - 邮件正文：`您的登录验证码是 492018，有效期为 10 分钟。请勿泄露给他人。`
  - **预期效果**：Telegram 收到消息，来源显示对应邮箱标签，验证码 `492018` 处于可直接点击复制状态，附带 1 句精炼中文摘要。
- **测试 2（验证/激活链接测试）**：
  - 邮件主题：`请确认您的账户激活`
  - 邮件正文：`点击下方链接激活：https://example.com/verify?token=abc123xyz`
  - **预期效果**：Telegram 消息卡片下方出现直达按钮 **[ 🚀 点击前往验证 / 激活 ]**，点击一键跳转浏览器。

### 2. 常见问题与排查表

| 现象 | 可能原因 | 解决办法 |
| :--- | :--- | :--- |
| **Telegram 收不到任何消息** | 1. 未先向 Bot 发起 `/start`<br>2. Secrets 中的 `TG_CHAT_ID` 或 `TG_BOT_TOKEN` 填写有误 | 1. 在 TG 中搜索并主动向 Bot 发送 `/start`<br>2. 检查 GitHub Secrets 并重新触发部署 |
| **QQ/Gmail 转发验证码没收到** | Cloudflare Email Routing 尚未生效或未绑定 Worker | 检查 Cloudflare 域名 DNS 是否包含 MX 记录，确保 Routing Rules 的 Action 是 Send to a Worker 且指定了 `mail-to-tg` |
| **AI 模型偶发不可用** | 触发了免费 Quota 限制或模型网络抖动 | 系统已配置**“自动动态抓取多候选模型轮换 + 本地正则终极防线”**，无需人工干预，系统会自动降级保障 100% 投递 |
| **如何查看 Worker 实时运行日志** | 排查具体邮件处理细节 | 在 Cloudflare 控制台进入 **Workers & Pages** $\rightarrow$ `mail-to-tg` $\rightarrow$ **Logs（日志）** 点击 **Begin stream** 查看实时流 |
