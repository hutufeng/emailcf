# Mail-to-TG: 多邮箱聚合通知与 AI 关键信息提取系统

基于 **Cloudflare Workers + Workers AI (Llama 3.1) + Telegram Bot** 的全无服务器（Serverless）多邮箱聚合通知方案。

## 🌟 核心特性
- **多邮箱汇聚**：统一管理 QQ 邮箱、Gmail、Outlook 等多个外部邮箱，按来源标签分类推送。
- **自动抓取与自适应模型切换**：自动调用 Cloudflare 官方 API 动态检索最新可用免费文本大模型，建立 24 小时内存缓存与自适应故障转移池（如 Llama 3.1、Qwen 1.5、Mistral），遇异常秒级无缝轮换。
- **终极本地规则防线**：若遭遇全网 AI 故障或额度耗尽，自动切换纯本地确定性正则引擎提取验证码与直达链接，永不宕机、永不漏发。
- **验证码一键复制**：自动提取邮件验证码，采用 Telegram `<code>` 样式，手机/桌面点击即可复制到剪贴板。
- **验证链接直达**：自动识别激活、验证、重置密码链接，生成内联直达按钮（Inline Keyboard）。
- **CI/CD 自动化**：GitHub Actions 持续集成，每次 `git push` 自动触发 Cloudflare 全球边缘部署。

---

## 🚀 快速推送到 GitHub 并在 Cloudflare 部署（Windows PowerShell）

在项目根目录下，执行以下标准 PowerShell 命令初始化 Git 并推送到你的 GitHub 仓库：

```powershell
# 1. 初始化本地仓库并提交文件
git init
git add .
git commit -m "feat: init mail-to-tg system with AI summary and CI/CD"

# 2. 关联远程仓库
git branch -M main
git remote add origin git@github.com:hutufeng/emailcf.git

# 3. 推送到 GitHub
git push -u origin main
```

---

## ⚙️ 详细配置手册
详细的 **Cloudflare DNS 配置**、**Telegram Bot 创建**、**GitHub Secrets 设置** 与 **各大邮箱自动转发教程**，请参阅：
📖 **[完整的实施方案指南](docs/IMPLEMENTATION_GUIDE.md)**

---

## 🛠️ 本地调试（可选）

```powershell
# 安装依赖
npm install

# 本地调试启动
npx wrangler dev
```
