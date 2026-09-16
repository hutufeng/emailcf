import PostalMime from 'postal-mime';
import { sendTelegramNotification } from './telegram.js';

// 全局内存模型缓存（有效缓存 24 小时）
let cachedModels = [];
let cacheExpireTime = 0;

// 静态高可用备用池（当 API 未配置或拉取失败时无缝启用）
const FALLBACK_MODELS = [
  '@cf/meta/llama-3.1-8b-instruct',
  '@cf/meta/llama-3-8b-instruct',
  '@cf/qwen/qwen1.5-7b-chat',
  '@cf/mistral/mistral-7b-instruct-v0.2',
  '@cf/google/gemma-7b-it'
];

export default {
  /**
   * 1. 邮件路由入口 (Cloudflare Email Routing)
   */
  async email(message, env, ctx) {
    const from = message.from || '未知发信人';
    const to = message.to || '';
    const sourceTag = resolveSourceTag(to);
    console.log(`[Email 收到新邮件] 来自: ${from} | 发往: ${to} | 映射标签: ${sourceTag}`);

    let emailSubject = '（无主题）';
    let textContent = '';
    let rawSnippet = '';

    try {
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

    // 调用具备“动态模型拉取 + 自动故障切换 + 本地规则兜底”的高可用提取引擎
    const extracted = await extractWithResilience(env, {
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
      isFallback: extracted.isFallback
    });
  },

  /**
   * 2. HTTP Webhook 入口 (支持 Gmail Pub/Sub 或外部推送)
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. 基础健康检查及当前活跃模型清单查看
    if (url.pathname === '/' || url.pathname === '/health') {
      const models = await getCandidateModels(env);
      return new Response(
        JSON.stringify({
          status: 'ok',
          time: new Date().toISOString(),
          activeModelPool: models
        }, null, 2),
        { headers: { 'Content-Type': 'application/json; charset=utf-8' } }
      );
    }

    // Webhook 触发地址
    if (request.method === 'POST' && url.pathname === '/webhook/mail') {
      try {
        const body = await request.json();
        const sourceTag = body.source || 'Webhook 推送';
        const from = body.from || 'Webhook Sender';
        const subject = body.subject || '（无主题）';
        const content = body.content || '';

        const extracted = await extractWithResilience(env, { from, subject, content });

        await sendTelegramNotification(env, {
          sourceTag,
          from,
          subject,
          code: extracted.code,
          link: extracted.link,
          summary: extracted.summary || content.slice(0, 200),
          isFallback: extracted.isFallback
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
 * 高可用自适应提取引擎：
 * 遍历动态候选模型池，遇异常自动切换；若全部失败，切换到纯本地正则规则引擎
 */
async function extractWithResilience(env, emailData) {
  const models = await getCandidateModels(env);

  // 1. 依次尝试动态模型
  for (const model of models) {
    try {
      const res = await callWorkersAI(env, model, emailData);
      if (res) {
        return { ...res, isFallback: false };
      }
    } catch (err) {
      console.warn(`[模型 ${model}] 调用失败，自动切换下一个候选模型. 原因: ${err.message}`);
    }
  }

  // 2. 所有 AI 模型调用失败（如 Quota 耗尽或服务中断），激活本地正则规则终极防线
  console.warn('全部 AI 模型不可用，自动切换到本地正则规则提取引擎');
  const localExtracted = extractWithLocalRules(emailData.subject, emailData.content);
  return { ...localExtracted, isFallback: true };
}

/**
 * 动态抓取 Cloudflare 官方当前可用的免费 Text Generation 模型库
 */
async function getCandidateModels(env) {
  const now = Date.now();
  if (cachedModels.length > 0 && now < cacheExpireTime) {
    return cachedModels;
  }

  let discovered = [];

  // 如果配置了 Cloudflare 账户凭证，动态查询官方 API
  if (env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN) {
    try {
      const url = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/models/search?task=Text%20Generation`;
      const resp = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
          'Content-Type': 'application/json'
        }
      });

      if (resp.ok) {
        const data = await resp.json();
        if (data.success && Array.isArray(data.result)) {
          // 智能筛选排序：优先匹配适合自然语言理解的轻量 Instruct / Chat 模型
          const validModels = data.result
            .map(m => m.name)
            .filter(name => typeof name === 'string' && name.startsWith('@cf/'));

          // 优先级评分排序
          discovered = validModels.sort((a, b) => scoreModel(b) - scoreModel(a));
        }
      } else {
        console.warn(`动态抓取 CF AI 模型 API 返回状态异常: ${resp.status}`);
      }
    } catch (apiErr) {
      console.warn(`动态抓取 CF AI 模型失败: ${apiErr.message}`);
    }
  }

  // 若动态抓取为空，融合静态高可用备用池
  if (discovered.length === 0) {
    discovered = FALLBACK_MODELS;
  } else {
    // 确保静态池中的优质推荐始终位于前列作为保底
    for (const fb of FALLBACK_MODELS.reverse()) {
      if (!discovered.includes(fb)) {
        discovered.unshift(fb);
      }
    }
  }

  // 缓存 24 小时
  cachedModels = discovered;
  cacheExpireTime = now + 24 * 60 * 60 * 1000;
  return cachedModels;
}

/**
 * 评级打分：优先使用性能优越、对多语言与结构化输出良好的开源模型
 */
function scoreModel(name) {
  let score = 0;
  const n = name.toLowerCase();
  if (n.includes('llama-3.1')) score += 50;
  else if (n.includes('llama-3')) score += 40;
  else if (n.includes('qwen')) score += 45; // 中文解析优异
  else if (n.includes('mistral')) score += 35;
  else if (n.includes('gemma')) score += 30;

  if (n.includes('instruct') || n.includes('chat')) score += 10;
  if (n.includes('8b') || n.includes('7b')) score += 5; // 7B/8B 延迟极低
  return score;
}

/**
 * 单个模型的 Workers AI 调用与结构化解析
 */
async function callWorkersAI(env, model, { from, subject, content }) {
  if (!env.AI) {
    throw new Error('Workers AI 绑定未生效');
  }

  const cleanContent = (content || '').slice(0, 3000);
  const prompt = `你是一个邮件信息提取助手。请从以下邮件中提取关键信息，并严格输出 JSON 格式。
必须包含的字段：
- "type": "code"（纯验证码类）、"link"（点击验证/激活/重置密码类）、"general"（普通通知/订阅/长邮件）
- "code": 提取出的纯数字或字母验证码字符串，若不存在填 null
- "link": 提取出的关键操作链接/激活链接 URL，若不存在填 null
- "summary": 1到2句话精简的中文概要，明确告知用户邮件核心意图

【邮件元数据】
发件人: ${from}
主题: ${subject}
正文:
${cleanContent}

禁止输出 JSON 以外的任何文本或解释说明。`;

  const response = await env.AI.run(model, {
    messages: [
      {
        role: 'system',
        content: '你是一个严格输出结构化 JSON 的数据提取程序。'
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
    throw new Error('未返回合法 JSON 结构');
  }

  const result = JSON.parse(jsonMatch[0]);
  return {
    type: result.type || 'general',
    code: result.code ? String(result.code).trim() : null,
    link: result.link ? String(result.link).trim() : null,
    summary: result.summary ? String(result.summary).trim() : null
  };
}

/**
 * 终极本地确定性规则提取引擎（Zero Cost & 100% 离线可用）
 */
function extractWithLocalRules(subject, content) {
  const fullText = `${subject || ''}\n${content || ''}`;

  // 1. 验证码规则：匹配常见“验证码/verification code/security code”附近的 4-8 位字符
  let code = null;
  const codeRegexList = [
    /(?:验证码|校验码|动态码|code|pin|security code)[^\d\w]{0,10}([0-9a-zA-Z]{4,8})\b/i,
    /\b([0-9]{4,8})\b(?=.*(?:验证码|动态码|code|有效))/i,
    /(?:is|为|是)[:\s]+([0-9]{4,8})\b/i
  ];

  for (const reg of codeRegexList) {
    const match = fullText.match(reg);
    if (match && match[1]) {
      // 排除全字母非典型验证码
      if (!/^[a-zA-Z]+$/.test(match[1]) || match[1].length <= 6) {
        code = match[1].trim();
        break;
      }
    }
  }

  // 2. 链接规则：匹配带有确认、激活、验证特征的 URL
  let link = null;
  const urlMatches = content.match(/https?:\/\/[^\s"'<>]+/gi) || [];
  for (const url of urlMatches) {
    const lowerUrl = url.toLowerCase();
    if (
      lowerUrl.includes('verify') ||
      lowerUrl.includes('activate') ||
      lowerUrl.includes('confirm') ||
      lowerUrl.includes('token') ||
      lowerUrl.includes('auth') ||
      lowerUrl.includes('reset')
    ) {
      link = url;
      break;
    }
  }

  // 3. 概要：截取有效文本
  const summary = (content || '').slice(0, 200).replace(/\s+/g, ' ').trim() || '（正文为空）';

  return {
    type: code ? 'code' : (link ? 'link' : 'general'),
    code,
    link,
    summary
  };
}

/**
 * 根据接收邮箱判定来源标签
 */
function resolveSourceTag(toAddress) {
  const lower = toAddress.toLowerCase();
  if (lower.includes('qq')) return 'QQ 邮箱';
  if (lower.includes('gmail')) return 'Gmail';
  if (lower.includes('outlook') || lower.includes('hotmail')) return 'Outlook';
  if (lower.includes('163') || lower.includes('netease')) return '网易 163';
  return '自定义邮箱';
}

function sanitizeHtml(html) {
  if (!html) return '';
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
