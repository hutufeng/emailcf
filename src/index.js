import PostalMime from 'postal-mime';
import { sendTelegramNotification } from './telegram.js';

export default {
  /**
   * 1. 邮件路由入口（接收 Cloudflare Email Routing 转发的邮件）
   */
  async email(message, env, ctx) {
    const from = message.from || '未知发信人';
    const to = message.to || '';

    // 根据收件别名映射来源标签
    const sourceTag = resolveSourceTag(to);

    let emailSubject = '（无主题）';
    let textContent = '';
    let rawSnippet = '';

    try {
      // 解析 MIME 邮件结构
      const rawEmail = await new Response(message.raw).arrayBuffer();
      const parser = new PostalMime();
      const parsed = await parser.parse(rawEmail);

      emailSubject = parsed.subject || emailSubject;
      textContent = parsed.text || sanitizeHtml(parsed.html) || '';
      rawSnippet = textContent.slice(0, 300).trim();
    } catch (parseErr) {
      console.error('MIME 解析异常，采用基础信封信息:', parseErr);
      rawSnippet = '邮件内容结构复杂，无法完整解析正文';
    }

    // 尝试使用 Workers AI 结构化提取；若失败，执行降级通知，绝不丢弃
    try {
      const extracted = await extractWithAI(env, {
        from,
        subject: emailSubject,
        content: textContent
      });

      await sendTelegramNotification(env, {
        sourceTag,
        from,
        subject: emailSubject,
        code: extracted.code,
        link: extracted.link,
        summary: extracted.summary || rawSnippet,
        isFallback: false
      });
    } catch (aiErr) {
      console.warn('AI 提取失败，触发优雅降级保底推送:', aiErr);
      await sendTelegramNotification(env, {
        sourceTag,
        from,
        subject: emailSubject,
        code: null,
        link: null,
        summary: rawSnippet || '（正文为空）',
        isFallback: true
      });
    }
  },

  /**
   * 2. HTTP Webhook 入口（支持直接接收 Gmail Pub/Sub 或外部 API 推送）
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 健康检查
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', time: new Date().toISOString() }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Webhook 接收入口: /webhook/mail
    if (request.method === 'POST' && url.pathname === '/webhook/mail') {
      try {
        const body = await request.json();
        const sourceTag = body.source || 'Webhook 推送';
        const from = body.from || 'Webhook Sender';
        const subject = body.subject || '（无主题）';
        const content = body.content || '';

        const extracted = await extractWithAI(env, { from, subject, content });

        await sendTelegramNotification(env, {
          sourceTag,
          from,
          subject,
          code: extracted.code,
          link: extracted.link,
          summary: extracted.summary || content.slice(0, 200),
          isFallback: false
        });

        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (err) {
        console.error('Webhook 处理错误:', err);
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    return new Response('Not Found', { status: 404 });
  }
};

/**
 * 根据接收邮箱前缀判定来源标签
 */
function resolveSourceTag(toAddress) {
  const lower = toAddress.toLowerCase();
  if (lower.includes('qq')) return 'QQ 邮箱';
  if (lower.includes('gmail')) return 'Gmail';
  if (lower.includes('outlook') || lower.includes('hotmail')) return 'Outlook';
  if (lower.includes('163') || lower.includes('netease')) return '网易 163';
  return '自定义邮箱';
}

/**
 * HTML 转纯文本过滤
 */
function sanitizeHtml(html) {
  if (!html) return '';
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 调用 Cloudflare Workers AI 进行实体提取与摘要生成
 */
async function extractWithAI(env, { from, subject, content }) {
  if (!env.AI) {
    throw new Error('Workers AI binding [AI] 未配置');
  }

  const model = env.DEFAULT_AI_MODEL || '@cf/meta/llama-3.1-8b-instruct';
  const cleanContent = (content || '').slice(0, 3000);

  const prompt = `你是一个专业的邮件信息提取助手。请从以下邮件中提取关键信息，并严格输出 JSON 格式。
必须包含的字段：
- "type": "code"（纯验证码类）、"link"（点击验证/激活/重置密码类）、"general"（普通通知/订阅/长邮件）
- "code": 提取出的纯数字或字母验证码字符串，若不存在填 null
- "link": 提取出的关键操作链接/激活链接 URL，若不存在填 null
- "summary": 1到2句话精简的中文概要，明确告知用户这封邮件的核心意图

【邮件元数据】
发件人: ${from}
主题: ${subject}
正文:
${cleanContent}

请注意：只输出严格合法的单个 JSON 对象，不要附加任何 Markdown 标记或多余文字。`;

  const response = await env.AI.run(model, {
    messages: [
      {
        role: 'system',
        content: '你是一个严格输出结构化 JSON 的数据提取程序，禁止输出任何除 JSON 以外的内容。'
      },
      {
        role: 'user',
        content: prompt
      }
    ],
    temperature: 0.1
  });

  const rawText = response.response || '';
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('AI 未返回有效 JSON 结构');
  }

  const result = JSON.parse(jsonMatch[0]);
  return {
    type: result.type || 'general',
    code: result.code ? String(result.code).trim() : null,
    link: result.link ? String(result.link).trim() : null,
    summary: result.summary ? String(result.summary).trim() : null
  };
}
