/**
 * Telegram 消息构建与发送模块
 */

export function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * 格式化并发送 Telegram 消息卡片
 */
export async function sendTelegramNotification(env, data) {
  const { sourceTag, from, subject, code, link, summary, isFallback } = data;

  const botToken = env.TG_BOT_TOKEN || env.tg_bot_token || env.BOT_TOKEN;
  const chatId = env.TG_CHAT_ID || env.tg_chat_id || env.CHAT_ID;

  if (!botToken || !chatId) {
    const errMsg = `[Telegram 配置缺失] TG_BOT_TOKEN 存在: ${!!botToken}, TG_CHAT_ID 存在: ${!!chatId}`;
    console.error(errMsg);
    throw new Error(errMsg);
  }

  let message = `🏷️ <b>[${escapeHtml(sourceTag)}] 新邮件提醒</b>\n\n`;
  message += `👤 <b>发件人:</b> <code>${escapeHtml(from)}</code>\n`;
  message += `📌 <b>主题:</b> ${escapeHtml(subject)}\n`;

  if (code) {
    message += `\n🔢 <b>验证码:</b> <code>${escapeHtml(code)}</code> <i>(点击直接复制)</i>\n`;
  }

  if (isFallback) {
    message += `\n⚠️ <i>[AI 模型解析跳过，已采用原文快速摘要]</i>\n`;
  }

  if (summary) {
    // 限制单段摘要长度，防止 Telegram 超过 4096 字符限制
    const safeSummary = escapeHtml(summary).slice(0, 2000);
    message += `\n📝 <b>概要:</b>\n${safeSummary}\n`;
  }

  // 验证链接安全清洗
  let cleanLink = null;
  if (link && typeof link === 'string') {
    const trimmed = link.trim();
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      try {
        cleanLink = new URL(trimmed).href;
      } catch (_) {
        cleanLink = null;
      }
    }
  }

  // 如果有验证链接，直接在正文输出超链接（注意：href 属性值必须严格使用 escapeHtml 转义 & 符号，防止 Telegram 实体解析崩溃）
  if (cleanLink) {
    message += `\n🔗 <b>验证/操作链接:</b>\n<a href="${escapeHtml(cleanLink)}">${escapeHtml(cleanLink)}</a>\n`;
  }

  // Telegram 消息总长度安全截断（注意：仅截断文本长度，不能破坏 HTML 标签）
  if (message.length > 4000) {
    message = message.slice(0, 3900) + '...';
  }

  const payload = {
    chat_id: String(chatId).trim(),
    text: message,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };

  // Telegram 按钮 URL 限制不可超 2048 字符且必须符合规范
  if (cleanLink && cleanLink.length <= 2048) {
    payload.reply_markup = {
      inline_keyboard: [
        [
          {
            text: '🚀 点击前往验证 / 激活',
            url: cleanLink
          }
        ]
      ]
    };
  }

  // 三级高可用发送机制：
  // 1. 尝试精美 HTML + 按钮发送
  // 2. 失败降级：剥离按钮后尝试 HTML 发送
  // 3. 仍失败降级（彻底免疫 Telegram 实体解析报错）：剥离所有 HTML 标签，以纯文本无损发送！
  try {
    return await executeTelegramSend(botToken, payload);
  } catch (err1) {
    console.warn('[Telegram 发送第 1 级失败，尝试剥离按钮降级]:', err1.message);
    if (payload.reply_markup) {
      delete payload.reply_markup;
      try {
        return await executeTelegramSend(botToken, payload);
      } catch (err2) {
        console.warn('[Telegram 发送第 2 级失败，尝试纯文本终极降级]:', err2.message);
      }
    }

    // 第 3 级：完全剥离 HTML 标签转为纯文本，移除 parse_mode，100% 保障可读性与送达
    const plainText = message
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");

    const fallbackPayload = {
      chat_id: String(chatId).trim(),
      text: plainText,
      disable_web_page_preview: true
    };

    return await executeTelegramSend(botToken, fallbackPayload);
  }
}

/**
 * 实际调用 Telegram API 发送（含 3 次重试）
 */
async function executeTelegramSend(botToken, payload, maxRetries = 3) {
  const cleanToken = String(botToken).trim();
  const url = `https://api.telegram.org/bot${cleanToken}/sendMessage`;
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const responseBody = await response.text();

      if (response.ok) {
        return JSON.parse(responseBody);
      }

      console.error(`[Telegram API 错误 HTTP ${response.status}] 详情:`, responseBody);
      lastError = new Error(`Telegram API [${response.status}]: ${responseBody}`);

      // 429 限流或 5xx 服务端错误等待重试
      if (response.status === 429 || response.status >= 500) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        continue;
      }

      // 其他 4xx 客户端格式错误不再重试直接抛出
      throw lastError;
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  }

  throw lastError;
}
