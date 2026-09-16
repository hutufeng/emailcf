const fs = require('fs');
const path = require('path');

const tomlPath = path.join(__dirname, '..', 'wrangler.toml');

if (fs.existsSync(tomlPath)) {
  let content = fs.readFileSync(tomlPath, 'utf8');

  const botToken = process.env.TG_BOT_TOKEN;
  const chatId = process.env.TG_CHAT_ID;

  let appendVars = '';

  if (botToken && !content.includes('TG_BOT_TOKEN =')) {
    appendVars += `\nTG_BOT_TOKEN = "${botToken.trim()}"`;
  }

  if (chatId && !content.includes('TG_CHAT_ID =')) {
    appendVars += `\nTG_CHAT_ID = "${chatId.trim()}"`;
  }

  if (appendVars) {
    console.log('[自动变量桥接] 成功从 Cloudflare 构建环境提取 TG_BOT_TOKEN 和 TG_CHAT_ID 并注入 wrangler.toml');
    fs.writeFileSync(tomlPath, content + appendVars, 'utf8');
  } else {
    console.log('[自动变量桥接] 构建环境中未检测到新的 TG 变量，保持原样');
  }
}
