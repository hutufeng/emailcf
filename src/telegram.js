/**
 * Telegram 消息构建与发送模块
 */

// HTML 特殊字符转义，防止破坏 Telegram parse_mode: 'HTML'
export function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * 格式化并发送 Telegram 消息卡片
 * @param {Object} env 环境变量
 * @param {Object} data 邮件信息与解析结果
 */
export async function sendTelegramNotification(env, data) {
  const { sourceTag, from, subject, code, link, summary, isFallback } = data;

  let message = `🏷️ <b>[${escapeHtml(sourceTag)}] 新邮件提醒</b>\n\n`;
  message += `👤 <b>发件人:</b> <code>${escapeHtml(from)}</code>\n`;
  message += `📌 <b>主题:</b> ${escapeHtml(subject)}\n`;

  // 1. 如果提取到了验证码：采用 Telegram 点击一键复制格式
  if (code) {
    message += `\n🔢 <b>验证码:</b> <code>${escapeHtml(code)}</code> <i>(点击直接复制)</i>\n`;
  }

  // 2. 状态标签（如果是降级兜底提醒）
  if (isFallback) {
    message += `\n⚠️ <i>[AI 模型不可用，已自动启用保底原文]</i>\n`;
  }

  // 3. 摘要或要点说明
  if (summary) {
    message += `\n📝 <b>概要:</b>\n${escapeHtml(summary)}\n`;
  }

  const payload = {
    chat_id: env.TG_CHAT_ID,
    text: message,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };

  // 4. 如果有验证链接：添加内联直达按钮 (Inline Keyboard)
  if (link && (link.startsWith('http://') || link.startsWith('https://'))) {
    payload.reply_markup = {
      inline_keyboard: [
        [
          {
            text: '🚀 点击前往验证 / 激活',
            url: link
          }
        ]
      ]
    };
  }

  // 5. 发送请求，包含指数退避重试（最多重试 3 次，防止网络瞬态故障）
  return await sendWithRetry(env.TG_BOT_TOKEN, payload, 3);
}

/**
 * 带重试的 Telegram API 调用
 */
async function sendWithRetry(botToken, payload, maxRetries = 3) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (response.ok) {
        return await response.json();
      }

      const errorText = await response.text();
      console.warn(`[Telegram API 尝试 ${attempt}/${maxRetries}] 失败: ${response.status} - ${errorText}`);

      // 如果遇到 429 限流或 5xx 服务端错误，等待后重试
      if (response.status === 429 || response.status >= 500) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        continue;
      }

      // 其他 4xx 客户端格式错误不再重试
      break;
    } catch (err) {
      lastError = err;
      console.warn(`[Telegram 网络异常 尝试 ${attempt}/${maxRetries}]: ${err.message}`);
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  }

  if (lastError) {
    throw lastError;
  }
}
