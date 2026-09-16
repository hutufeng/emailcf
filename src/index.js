import PostalMime from 'postal-mime';
import { sendTelegramNotification } from './telegram.js';

// 全局内存模型缓存（有效缓存 24 小时）
let cachedModels = [];
let cacheExpireTime = 0;

// 静态高可用备用池（仅选择 Cloudflare 官方 30B~70B 级别中上大模型，保障中文提炼质量与推理能力）
const FALLBACK_MODELS = [
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
  '@cf/meta/llama-3-70b-instruct',
  '@cf/qwen/qwen2.5-72b-instruct'
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

    // 安全防御：若配置了授权转发原邮箱白名单，非白名单来源邮件直接静默丢弃
    if (env.MY_FORWARDING_EMAILS) {
      const allowedList = String(env.MY_FORWARDING_EMAILS)
        .split(/[,，\s]+/)
        .map(e => e.trim().toLowerCase())
        .filter(Boolean);

      if (allowedList.length > 0) {
        const rawHeaders = message.headers ? JSON.stringify(Object.fromEntries(message.headers)) : '';
        const isAuthorized = allowedList.some(email =>
          from.toLowerCase().includes(email) ||
          to.toLowerCase().includes(email) ||
          rawHeaders.toLowerCase().includes(email)
        );

        if (!isAuthorized) {
          console.warn(`[安全拦截] 邮件来源未匹配授权原邮箱列表 (${from} -> ${to})，已静默忽略`);
          return;
        }
      }
    }

    let emailSubject = '（无主题）';
    let textContent = '';
    let rawSnippet = '';

    try {
      const rawEmail = await new Response(message.raw).arrayBuffer();
      const parser = new PostalMime();
      const parsed = await parser.parse(rawEmail);

      emailSubject = parsed.subject || emailSubject;

      const rawHtml = parsed.html || '';
      const htmlConverted = rawHtml ? convertHtmlToText(rawHtml) : '';
      const rawText = parsed.text || '';

      // 若 rawText 太短（如部分邮件只在 text 留系统标语），使用 HTML 转换文本
      if (rawText.trim().length < 60 && htmlConverted.length > rawText.length) {
        textContent = htmlConverted;
      } else {
        textContent = rawText || htmlConverted || '';
      }

      rawSnippet = extractCleanSnippet(textContent);

      // 双引擎智能提取：规则保障验证码/链接 100% 确定性，AI 负责中文摘要提炼
      const extracted = await extractWithResilience(env, {
        from,
        subject: emailSubject,
        content: textContent,
        rawHtml
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
    } catch (parseErr) {
      console.error('邮件处理异常:', parseErr);
      // 容灾保障：即使后续处理出现意外，优先展示已解析到的正文片段，杜绝正文被死板提示覆盖
      const fallbackSummary = rawSnippet || (textContent ? textContent.slice(0, 200) : '邮件已送达，请查看主题与发件人');
      await sendTelegramNotification(env, {
        sourceTag,
        from,
        subject: emailSubject,
        code: null,
        link: null,
        summary: `${fallbackSummary}\n\n⚠️ 处理提示: ${parseErr.message || '未知异常'}`,
        isFallback: true
      });
    }
  },

  /**
   * 2. HTTP Webhook 入口 (支持模拟测试与外部推送)
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
          has_ai_binding: !!env.AI,
          activeModelPool: models
        }, null, 2),
        { headers: { 'Content-Type': 'application/json; charset=utf-8' } }
      );
    }

    // 2. Webhook 触发地址（支持本地或外部直接 POST 模拟邮件测试）
    if (request.method === 'POST' && url.pathname === '/webhook/mail') {
      try {
        const body = await request.json();
        const sourceTag = body.source || 'Webhook 测试';
        const from = body.from || 'test-sender@example.com';
        const subject = body.subject || '（无主题）';
        const content = body.content || '';
        const rawHtml = body.html || '';

        const extracted = await extractWithResilience(env, { from, subject, content, rawHtml });

        await sendTelegramNotification(env, {
          sourceTag,
          from,
          subject,
          code: extracted.code,
          link: extracted.link,
          summary: extracted.summary || content.slice(0, 200),
          isFallback: extracted.isFallback
        });

        return new Response(JSON.stringify({ success: true, extracted }), {
          headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
      } catch (err) {
        console.error('Webhook 处理错误:', err);
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
      }
    }

    return new Response('Not Found', { status: 404 });
  }
};

/**
 * 高可用多级智能提取引擎：
 * 规则引擎保障核心验证码与主链接绝对精准，AI 引擎生成自然中文摘要
 */
async function extractWithResilience(env, emailData) {
  // 1. 本地规则优先提取核心验证码与最佳操作链接（零幻觉，100% 准确）
  const localRule = extractWithLocalRules(emailData.subject, emailData.content, emailData.rawHtml);

  // 2. 尝试调用 Workers AI 生成地道中文摘要
  let aiSummary = null;
  let isAiSuccess = false;

  const models = await getCandidateModels(env);
  for (const model of models) {
    try {
      const summaryText = await callWorkersAI(env, model, emailData);
      if (summaryText) {
        aiSummary = summaryText;
        isAiSuccess = true;
        break;
      }
    } catch (err) {
      console.warn(`[模型 ${model}] 生成摘要重试: ${err.message}`);
    }
  }

  // 3. 摘要合并：优先使用 AI 生成的生动中文摘要，兜底使用本地原文提炼
  const finalSummary = (isAiSuccess && aiSummary) ? aiSummary : localRule.summary;

  return {
    code: localRule.code,
    link: localRule.link,
    summary: finalSummary,
    isFallback: !isAiSuccess
  };
}

/**
 * 动态抓取 Cloudflare 官方可用免费 Text Generation 模型（严格过滤：仅挑选 30B ~ 70B 中上大模型）
 */
async function getCandidateModels(env) {
  const now = Date.now();
  if (cachedModels.length > 0 && now < cacheExpireTime) {
    return cachedModels;
  }

  let discovered = [];

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
          // 仅筛选属于 @cf/ 且评分 > 0（确认为 30B~70B 中大模型）的优质模型
          const validModels = data.result
            .map(m => m.name)
            .filter(name => typeof name === 'string' && name.startsWith('@cf/') && scoreModel(name) > 0);

          discovered = validModels.sort((a, b) => scoreModel(b) - scoreModel(a));
        }
      }
    } catch (apiErr) {
      console.warn(`动态抓取 CF AI 模型失败: ${apiErr.message}`);
    }
  }

  if (discovered.length === 0) {
    discovered = [...FALLBACK_MODELS];
  } else {
    for (const fb of FALLBACK_MODELS) {
      if (!discovered.includes(fb)) {
        discovered.push(fb);
      }
    }
  }

  cachedModels = discovered;
  cacheExpireTime = now + 24 * 60 * 60 * 1000;
  console.log(`[Workers AI 选型] 当前就绪中上大模型池:`, cachedModels);
  return cachedModels;
}

/**
 * 模型分级与质量评分体系：
 * - 排除所有 < 30B 参数的小模型（1B/2B/3B/7B/8B/mini 等打负分淘汰）
 * - 重点遴选中上大模型（70B/72B/32B/Large），保障地道中文提炼与高阶推理
 */
function scoreModel(name) {
  const n = name.toLowerCase();

  // 1. 坚决排除小参数、轻量级模型
  const isSmallModel = /\b(0\.5b|1b|1\.5b|2b|3b|4b|7b|8b|9b|11b|13b|14b)\b/.test(n) ||
    n.includes('tiny') || n.includes('mini') || n.includes('small') || n.includes('micro') || n.includes('nano');
  if (isSmallModel) {
    return -1;
  }

  let score = 0;

  // 2. 超大参数量级（70B ~ 72B）- 最高优先级
  if (n.includes('72b') || n.includes('70b')) {
    score += 100;
    if (n.includes('llama-3.3')) score += 20; // Llama 3.3 70B 指令与多语言极强
    if (n.includes('qwen2.5')) score += 15;   // Qwen 2.5 中文理解天花板
  }
  // 3. 中大参数量级（30B ~ 35B）- 次高优先级
  else if (n.includes('32b') || n.includes('30b') || n.includes('33b') || n.includes('34b')) {
    score += 75;
    if (n.includes('deepseek-r1')) score += 15; // DeepSeek R1 深度推理
    if (n.includes('qwen')) score += 10;
  }
  // 4. 显式声明为 large 的大模型
  else if (n.includes('large')) {
    score += 50;
  } else {
    // 其余无明确大模型标识的一律不选用
    return -1;
  }

  return score;
}

/**
 * 单个模型的 Workers AI 调用：纯净提炼自然中文摘要（兼容 DeepSeek R1 思考标签过滤）
 */
async function callWorkersAI(env, model, { from, subject, content }) {
  if (!env.AI) {
    throw new Error('Workers AI 绑定未配置');
  }

  const cleanContent = (content || '').slice(0, 3000);
  const prompt = `请阅读以下邮件内容，提炼出 1 到 2 句通顺、流畅、自然的中文摘要，准确概括邮件的核心目的或关键通知事项（字数控制在60字以内）。

发件人: ${from}
主题: ${subject}
正文:
${cleanContent}

请直接输出中文摘要内容，严禁输出“摘要：”、“这是一封”等任何多余前缀：`;

  let rawText = '';
  try {
    const res = await env.AI.run(model, {
      prompt,
      max_tokens: 200
    });
    rawText = res?.response || (typeof res === 'string' ? res : '');
  } catch (e) {
    const res = await env.AI.run(model, {
      messages: [
        { role: 'system', content: '你是一个专业的中文邮件助手，擅长准确、精炼地总结邮件核心意图。' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 200
    });
    rawText = res?.response || (typeof res === 'string' ? res : '');
  }

  // 深度清洗：剔除 deepseek-r1 的 <think>...</think> 思考标签，过滤 markdown 格式残留并规范化
  let cleanedSummary = (rawText || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```[\s\S]*?```/gi, '')
    .replace(/[#*`_]/g, '')
    .replace(/^摘要[：:]\s*/i, '')
    .replace(/^总结[：:]\s*/i, '')
    .replace(/^核心意图[：:]\s*/i, '')
    .replace(/^这是一封[：:]\s*/i, '')
    .split(/\r?\n+/)
    .map(s => s.trim())
    .filter(Boolean)[0] || ''; // 若模型分段输出，只取最核心的第一句概括

  cleanedSummary = cleanedSummary.trim();

  // 严格校验：如果是复读的提示词，予以剔除重试下一个模型
  if (
    !cleanedSummary ||
    cleanedSummary.includes('1到2句') ||
    cleanedSummary.includes('中文概要') ||
    cleanedSummary.includes('不超过50字') ||
    cleanedSummary.length < 5
  ) {
    throw new Error('AI 生成摘要未满足质量要求');
  }

  return cleanedSummary;
}

/**
 * 鲁棒 JSON 提取清洗器（防御大模型输出非标字符、Markdown 块、未转义引号）
 */
function safeParseAIJson(rawText) {
  if (!rawText) throw new Error('AI 未返回任何文本');

  // 1. 去除可能存在的 markdown 代码块包裹
  let cleaned = rawText.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

  // 2. 截取最外层的 JSON 大括号
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.substring(firstBrace, lastBrace + 1);
  }

  // 3. 尝试直接解析
  try {
    const obj = JSON.parse(cleaned);
    return {
      summary: obj.summary ? String(obj.summary).trim() : null,
      code: obj.code ? String(obj.code).trim() : null,
      link: obj.link ? String(obj.link).trim() : null
    };
  } catch (e) {
    console.warn('标准 JSON.parse 失败，启用正则容错提取:', e.message);
  }

  // 4. 容错提取策略：直接从文本正则捕获各字段
  const summaryMatch = cleaned.match(/"summary"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/i);
  const codeMatch = cleaned.match(/"code"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/i);
  const linkMatch = cleaned.match(/"link"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/i);

  const summary = summaryMatch ? summaryMatch[1].replace(/\\"/g, '"') : null;
  const code = codeMatch ? codeMatch[1].replace(/\\"/g, '"') : null;
  const link = linkMatch ? linkMatch[1].replace(/\\"/g, '"') : null;

  if (!summary && !code && !link) {
    throw new Error(`AI 输出无法解析为有效字段: ${cleaned.slice(0, 100)}`);
  }

  return { summary, code, link };
}

/**
 * 强化版全能本地确定性规则引擎
 */
function extractWithLocalRules(subject, content, rawHtml = '') {
  const fullText = `${subject || ''}\n${content || ''}`;

  // 1. 全面升级的验证码正则引擎（覆盖复合词与跨行匹配）
  let code = null;
  const codeRegexList = [
    // 形式 A: 关键词后跟冒号/空格/等号，直接抓取 4-8 位字母数字
    /(?:security\s*code|verification\s*code|auth\s*code|login\s*code|one-time\s*(?:password|code)|passcode|otp|验证码|校验码|动态码|安全码)\s*[:：\s=is为是]+\s*([0-9a-zA-Z]{4,8})\b/i,
    // 形式 B: 临近区域提取纯数字（前后 30 字符内有 code/验证码 相关词）
    /(?:security|verification|code|pin|otp|验证码|校验码|动态码)[^\d\w]{1,30}\b([0-9]{4,8})\b/i,
    // 形式 C: 独立成行或简短提示的验证码（如 Code: 123456）
    /(?:is|为|是|：|:)\s*([0-9]{4,8})\b/i
  ];

  for (const reg of codeRegexList) {
    const match = fullText.match(reg);
    if (match && match[1]) {
      const candidate = match[1].trim();
      // 排除年份或纯过长英文单词
      if (!/^(19|20)\d{2}$/.test(candidate) && (!/^[a-zA-Z]+$/.test(candidate) || candidate.length <= 6)) {
        code = candidate;
        break;
      }
    }
  }

  // 2. 强化版多链接智能评分引擎：从海量链接中挑选出唯一的“真正验证链接”
  const link = extractBestActionLink(rawHtml, content);

  // 3. 本地摘要提炼
  let summary = '';
  if (subject && (subject.includes('自动转发验证') || subject.includes('转发验证'))) {
    summary = 'QQ 邮箱自动转发授权申请，请点击操作链接完成绑定。';
  } else {
    summary = extractCleanSnippet(content);
  }

  return {
    type: code ? 'code' : (link ? 'link' : 'general'),
    code,
    link,
    summary
  };
}

/**
 * 智能链接权重打分与去重过滤引擎
 */
function extractBestActionLink(rawHtml, content) {
  const candidates = new Set();

  // 1. 从 HTML 的 <a> 标签 href 中提取
  if (rawHtml) {
    const hrefMatches = rawHtml.matchAll(/href=["'](https?:\/\/[^"'\s<>]+)["']/gi);
    for (const match of hrefMatches) {
      candidates.add(match[1].replace(/&amp;/g, '&'));
    }
  }

  // 2. 从纯文本中提取 URL（并自动剥除末尾标点符号，防止误伤链接）
  const textUrls = (content || '').match(/https?:\/\/[^\s"'<>]+/gi) || [];
  for (const url of textUrls) {
    const cleanUrl = url.replace(/[.,;!?)\]>]+$/, '');
    if (cleanUrl) candidates.add(cleanUrl);
  }

  if (candidates.size === 0) return null;

  // 黑名单关键词：无用服务链接直接淘汰
  const BLACKLIST = [
    'unsubscribe', 'optout', 'privacy', 'policy', 'terms', 'agreement',
    'help', 'support', 'contact', 'about', 'facebook.com', 'twitter.com',
    'linkedin.com', 'instagram.com', 'youtube.com', 'w3.org', 'schemas.microsoft.com',
    'googleapis.com', 'gstatic.com', 'googlefonts', 'cloudflare.com', 'gravatar.com', 'wp.com'
  ];

  let bestLink = null;
  let highestScore = -999;

  for (const rawUrl of candidates) {
    const lower = rawUrl.toLowerCase();

    // 1. 命中黑名单域名或关键字直接跳过
    if (BLACKLIST.some(kw => lower.includes(kw))) continue;

    // 2. 拦截常见静态资源文件和字体样式文件（如 fonts.googleapis.com 引入的 css/woff）
    if (/\.(css|js|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf)(\?.*)?$/i.test(lower)) continue;

    let score = 0;

    // A. 关键动作路径加分
    if (lower.includes('verify')) score += 100;
    if (lower.includes('confirm')) score += 90;
    if (lower.includes('activate')) score += 85;
    if (lower.includes('reset')) score += 80;
    if (lower.includes('security')) score += 70;
    if (lower.includes('forward')) score += 65;
    if (lower.includes('mail.qq.com')) score += 60;

    // B. 安全凭证长参数加分（一次性验证链接通常很长）
    if (lower.includes('token=')) score += 80;
    if (lower.includes('auth=')) score += 70;
    if (lower.includes('ticket=')) score += 65;
    if (lower.includes('code=')) score += 60;
    if (lower.includes('action=')) score += 50;
    if (rawUrl.length > 50) score += 30;

    // C. 纯根域名或官网首页大扣分
    try {
      const u = new URL(rawUrl);
      if (u.pathname === '/' || u.pathname === '') score -= 100;
    } catch (_) {
      score -= 50;
    }

    if (score > highestScore && score > 0) {
      highestScore = score;
      bestLink = rawUrl;
    }
  }

  // 若无明显高分验证链接，降级返回第一个非黑名单链接
  if (!bestLink) {
    for (const url of candidates) {
      const lower = url.toLowerCase();
      if (!BLACKLIST.some(kw => lower.includes(kw))) {
        bestLink = url;
        break;
      }
    }
  }

  return bestLink;
}

function extractCleanSnippet(text) {
  if (!text) return '（正文为空）';
  const clean = text
    .replace(/^QQ邮箱\s*/i, '')
    .replace(/^QQmail\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.slice(0, 250) || text.slice(0, 250);
}

function convertHtmlToText(html) {
  if (!html) return '';
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, ' $2 ($1) ')
    .replace(/<(?:p|div|tr|br|h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

function resolveSourceTag(toAddress) {
  const lower = toAddress.toLowerCase();
  if (lower.includes('qq')) return 'QQ 邮箱';
  if (lower.includes('gmail')) return 'Gmail';
  if (lower.includes('outlook') || lower.includes('hotmail')) return 'Outlook';
  if (lower.includes('163') || lower.includes('netease')) return '网易 163';
  return '自定义邮箱';
}
