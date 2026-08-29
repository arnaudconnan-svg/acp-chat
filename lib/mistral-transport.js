'use strict';

const { Mistral } = require('@mistralai/mistralai');

const DEFAULT_TIMEOUT_MS = 55000;
const DEFAULT_MAX_RETRIES = 2;

function normalizeUsage(rawUsage = null) {
  if (!rawUsage || typeof rawUsage !== 'object') return null;
  const promptTokens = Number(rawUsage.promptTokens ?? rawUsage.prompt_tokens);
  const completionTokens = Number(
    rawUsage.completionTokens ?? rawUsage.completion_tokens
  );
  const totalTokens = Number(rawUsage.totalTokens ?? rawUsage.total_tokens);
  const normalized = {
    promptTokens: Number.isFinite(promptTokens) ? promptTokens : 0,
    completionTokens: Number.isFinite(completionTokens) ? completionTokens : 0,
    totalTokens: Number.isFinite(totalTokens) ? totalTokens : 0
  };
  if (!normalized.totalTokens) {
    normalized.totalTokens =
      normalized.promptTokens + normalized.completionTokens;
  }
  return normalized.totalTokens > 0 ? normalized : null;
}

function normalizeContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      return part && typeof part.text === 'string' ? part.text : '';
    })
    .join('');
}

function normalizeCompletion(response = null) {
  const choice = response?.choices?.[0] || null;
  return {
    content: normalizeContent(choice?.message?.content),
    finishReason: choice?.finishReason ?? choice?.finish_reason ?? null,
    usage: normalizeUsage(response?.usage),
    raw: response
  };
}

function normalizeStreamChunk(event = null) {
  const chunk = event?.data || event || null;
  const choice = chunk?.choices?.[0] || null;
  return {
    content: normalizeContent(choice?.delta?.content),
    finishReason: choice?.finishReason ?? choice?.finish_reason ?? null,
    usage: normalizeUsage(chunk?.usage),
    raw: event
  };
}

function isRetryableError(error) {
  const status = Number(error?.status ?? error?.statusCode);
  if ([408, 409, 429].includes(status) || status >= 500) return true;
  const name = String(error?.name || '').toLowerCase();
  const code = String(error?.code || '').toLowerCase();
  return (
    name.includes('timeout') ||
    name.includes('connection') ||
    code === 'econnreset' ||
    code === 'etimedout'
  );
}

function readRetryDelayMs(error, attempt) {
  const retryAfter = Number(
    error?.headers?.get?.('retry-after-ms') || error?.retryAfterMs
  );
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter, 2500);
  }
  return Math.min(400 * (attempt + 1), 2500);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createMistralTransport({
  apiKey = '',
  client = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxRetries = DEFAULT_MAX_RETRIES,
  sleep = wait,
  onUsage = null
} = {}) {
  const safeApiKey = String(apiKey || '').trim();
  const mistralClient =
    client || (safeApiKey ? new Mistral({ apiKey: safeApiKey }) : null);

  function assertConfigured() {
    if (!mistralClient) {
      const error = new Error('MISTRAL_API_KEY is not configured');
      error.code = 'mistral_not_configured';
      throw error;
    }
  }

  async function execute(operation) {
    let attempt = 0;
    while (true) {
      try {
        return await operation();
      } catch (error) {
        if (!isRetryableError(error) || attempt >= maxRetries) throw error;
        await sleep(readRetryDelayMs(error, attempt));
        attempt += 1;
      }
    }
  }

  function reportUsage(usage) {
    if (usage && typeof onUsage === 'function') onUsage(usage);
  }

  return {
    isConfigured: Boolean(mistralClient),
    async complete(request) {
      assertConfigured();
      const response = await execute(() =>
        mistralClient.chat.complete(request, {
          timeoutMs,
          retries: { strategy: 'none' }
        })
      );
      const normalized = normalizeCompletion(response);
      reportUsage(normalized.usage);
      return normalized;
    },
    async stream(
      request,
      { onToken, reportUsage: shouldReportUsage = true } = {}
    ) {
      assertConfigured();
      const eventStream = await execute(() =>
        mistralClient.chat.stream(request, {
          timeoutMs,
          retries: { strategy: 'none' }
        })
      );
      let content = '';
      let finishReason = null;
      let usage = null;
      for await (const event of eventStream) {
        const chunk = normalizeStreamChunk(event);
        if (chunk.content) {
          content += chunk.content;
          if (typeof onToken === 'function') await onToken(chunk.content);
        }
        if (chunk.finishReason) finishReason = chunk.finishReason;
        if (chunk.usage) usage = chunk.usage;
      }
      if (shouldReportUsage) reportUsage(usage);
      return { content, finishReason, usage, raw: null };
    }
  };
}

module.exports = {
  createMistralTransport,
  isRetryableError,
  normalizeCompletion,
  normalizeStreamChunk,
  normalizeUsage
};
