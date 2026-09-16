# 多邮箱聚合通知与 AI 关键信息提取系统实施方案

本项目基于 **Cloudflare Email Routing + Workers + Workers AI + Telegram Bot** 实现多邮箱实时聚合、验证码/链接一键提取与中文摘要推送。

---

## 目录
1. [系统整体架构](#1-系统整体架构)
2. [可靠性与防丢失设计（第一性原理）](#2-可靠性与防丢失设计第一性原理)
3. [第 1 步：Telegram Bot 准备](#第-1-步telegram-bot-准备)
4. [第 2 步：Cloudflare 域名与 Email Routing 设置](#第-2-步cloudflare-域名与-email-routing-设置)
5. [第 3 步：GitHub 仓库与 CI/CD 自动化部署配置](#第-3-步github-仓库与-cicd-自动化部署配置)
6. [第 4 步：各大邮箱转发与双通道绑定](#第-4-步各大邮箱转发与双通道绑定)
7. [第 5 步：端到端验证与故障排查](#第-5-步端到端验证与故障排查)

---

## 1. 系统整体架构

```text
各邮箱（QQ / Gmail / Outlook）
      │
      ├─ 实时自动转发 ───► CF Email Routing ───► Worker (email handler)
      │                                                │
      └─ Webhook/PubSub ──► CF Worker (fetch handler) ──┤
                                                       ▼
                                         MIME 解析 (postal-mime)
                                                       │
                                                       ▼
                                      Workers AI (Llama 3.1 8B)
                                  [提取验证码 / 激活链接 / 中文摘要]
                                                       │
                                                       ▼ (失败自动降级纯文本)
                                       Telegram Bot 格式化推送
                                  • 来源邮箱标签区分
                                  • <code>验证码</code> 点击即复制
                                  • [直达按钮] 一键跳转验证链接
```

---

## 2. 可靠性与防丢失设计（第一性原理）

### 为什么常规转发容易失败或延迟？
1. **DMARC / SPF 阻断**：严苛域名（银行、政企、各大平台登录邮件）设有 `p=reject` 策略。如果域名转发未配置合规的 SPF/DMARC，会被判定为伪造发件人拒收。
2. **频率限制与灰名单（Greylisting）**：发件量突增时，边缘服务商会返回 4xx 临时延时错误。
3. **Worker 崩溃导致丢件**：若邮件格式异常导致 Worker 报未捕获异常（Uncaught Exception），邮件路由可能退信。

### 本项目的 4 重可靠性保障：
- **DNS 加固**：在 Cloudflare 域名严格配置 MX 与 SPF (`v=spf1 include:_spf.mx.cloudflare.net ~all`)，杜绝因域名信誉导致的拒收。
- **原邮箱双存留**：所有邮箱转发规则中，必须勾选**“在原收件箱保留邮件备份”**，即使遇到灾难性网络中断，数据在原邮箱永不丢失。
- **零异常退出保障（Fail-safe）**：Worker 内部对 MIME 解析、AI 请求全流程包裹降级兜底。若 AI 故障或额度耗尽，自动降级为“原文提取前 200 字直接推送”，确保每封邮件必达。
- **Telegram 网络抖动重试**：内置 3 次指数退避网络重试，防御 Telegram 偶发 429 或连接中断。

---

## 3. 第 1 步：Telegram Bot 准备

1. 打开 Telegram，搜索官方账号 `@BotFather`。
2. 发送 `/newbot`，按照指引输入 Bot 名称和 username，获得一串 `TG_BOT_TOKEN`（形如 `7123456789:AAH...`）。
3. 搜索并启动 `@userinfobot`，获取你的个人 Telegram `Id`（纯数字，即 `TG_CHAT_ID`）。
4. **测试**：在 Telegram 中先主动对你的新 Bot 发送一条任意消息 `/start`（这是 Telegram 限制：用户必须先与 Bot 对话，Bot 才能主动发消息）。

---

## 4. 第 2 步：Cloudflare 域名与 Email Routing 设置

1. 登录 [Cloudflare 控制台](https://dash.cloudflare.com/)，进入你的托管域名。
2. 左侧菜单点击 **Email Routing（电子邮件路由）**，开启服务：
   - 按照页面向导自动添加 Cloudflare 默认的 MX 记录与 SPF TXT 记录。
3. 进入 **Routing rules（路由规则）**：
   - 添加以下自定义别名规则，**Action 选择“Send to a Worker”**，并选中 `mail-to-tg`：
     - `qq-in@yourdomain.com` -> `mail-to-tg`
     - `gmail-in@yourdomain.com` -> `mail-to-tg`
     - `outlook-in@yourdomain.com` -> `mail-to-tg`
     - （可选）`*@yourdomain.com` (Catch-all) -> `mail-to-tg`

---

## 5. 第 3 步：GitHub 仓库与 CI/CD 自动化部署配置

本项目已配置好了 `.github/workflows/deploy.yml`。

### 1) 获取 Cloudflare 凭证
- **API Token**：
  - 访问 Cloudflare 控制台 -> 我的个人资料 -> API 令牌 -> 创建令牌。
  - 选择模板 **“编辑 Cloudflare Workers”**（包含 Workers Scripts 编辑、Workers AI 读取权限）。
- **Account ID**：
  - 在 Cloudflare 控制台右下角或 Workers 仪表盘右侧复制你的 **账户 ID**。

### 2) 在 GitHub 仓库配置 Secrets
在 GitHub 仓库页面进入 `Settings` -> `Secrets and variables` -> `Actions` -> `New repository secret`，依次添加 4 个密钥：
- `CLOUDFLARE_API_TOKEN`: 上一步生成的 Cloudflare API 令牌
- `CLOUDFLARE_ACCOUNT_ID`: 你的 Cloudflare 账户 ID
- `TG_BOT_TOKEN`: 你的 Telegram Bot Token
- `TG_CHAT_ID`: 你的 Telegram Chat ID

### 3) 触发部署
只需在本地执行 `git push origin main`，GitHub Actions 就会自动构建并将最新代码推送到 Cloudflare 边缘节点。

---

## 6. 第 4 步：各大邮箱转发与双通道绑定

> **重要提示**：在各邮箱添加转发地址时，服务商会向目标地址发送一封**“确认验证邮件”**。此时因 Worker 和 TG Bot 已经部署上线，验证邮件会**直接推送到你的 Telegram**，你只需在 Telegram 中复制验证码或点击激活按钮即可完成验证！

### 1. QQ 邮箱配置
1. 打开网页版 QQ 邮箱 -> 【设置】-> 【账户】。
2. 滚到【自动转发】模块，勾选“开启”。
3. 填入转发地址：`qq-in@yourdomain.com`。
4. **必须勾选**：【在 QQ 邮箱中保留邮件备份】。
5. 前往 Telegram 查收 QQ 邮箱发来的验证邮件，点击链接确认即可生效。

### 2. Gmail 邮箱配置
1. 打开 Gmail 网页版 -> 点击右上角齿轮 -> 【查看所有设置】。
2. 切换到【转发和 POP/IMAP】选项卡。
3. 点击【添加转发地址】，输入 `gmail-in@yourdomain.com`。
4. 前往 Telegram 复制收到的 9 位数验证码，回填到 Gmail 中验证。
5. 选中【将收到的邮件转发给...】，并在下拉菜单中选择【在收件箱保留 Gmail 副本】。

### 3. Outlook / Hotmail 配置
1. 打开网页版 Outlook -> 点击右上角齿轮【设置】-> 【邮件】-> 【转发】。
2. 开启转发，填入 `outlook-in@yourdomain.com`。
3. 勾选【保留已转发邮件的副本】。
4. 点击保存。

---

## 7. 第 5 步：端到端验证与故障排查

### 验证方法
用另一个无关邮箱（如手机 139 邮箱或朋友邮箱）向你的 QQ 邮箱发送测试邮件：
- 测试 1（验证码）：主题“登录验证码”，正文写“您的验证码为 849201，有效期 5 分钟”。
  - **预期效果**：Telegram 收到带 `[QQ 邮箱]` 标签的卡片，验证码高亮显示，手机端轻点直接复制。
- 测试 2（激活链接）：正文包含一个 URL。
  - **预期效果**：Telegram 卡片下方出现内联跳转按钮，点击直达。

### 常见问题排查
1. **Telegram 没有收到消息**：
   - 检查是否在 Telegram 中主动与 Bot 发起过 `/start` 对话。
   - 在 Cloudflare 控制台 -> Workers & Pages -> `mail-to-tg` -> **Logs（实时日志）** 观察是否有邮件触发。
2. **QQ 邮箱转发提示失败**：
   - 检查 Cloudflare 域名的 MX 记录是否生效（通常几分钟内解析完成）。
3. **AI 偶尔解析不完整**：
   - 程序内置了智能降级兜底，只要 AI 遇到任何异常，都会立即回退推送原始摘要，绝不会丢失邮件。
