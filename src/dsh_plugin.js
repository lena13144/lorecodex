'use strict';

/**
 * LoreCodex Native Plugin for DeepSeek Harness (dsh / @deepseek-ai/cordis)
 *
 * Compatible with `@deepseek-ai/cordis` and `@deepseek-ai/dsh-tools`.
 * Registers all 8 LoreCodex 3-tier tree navigation, millisecond in-RAM alias/cameo grep,
 * sidecar agent distillation, and corpus building tools into `ctx.tools`.
 */

const name = 'lorecodex';
const inject = ['tools'];

/**
 * Convert MCP JSON Schema inputSchema into DeepSeek Harness `defineTool` parameters map.
 */
function toDshParameters(inputSchema) {
  const props = (inputSchema && inputSchema.properties) || {};
  const reqSet = new Set((inputSchema && inputSchema.required) || []);
  const out = {};
  for (const [key, def] of Object.entries(props)) {
    const param = {
      type: def.type || 'string',
      required: reqSet.has(key),
      description: def.description || '',
    };
    if (def.items) param.items = def.items;
    if (def.enum) param.enum = def.enum;
    out[key] = param;
  }
  return out;
}

/**
 * Build a tool definition compatible with `@deepseek-ai/dsh-tools` `defineTool(...)`.
 */
function buildDshToolSpec(mcpTool, pluginConfig = {}, handleToolCallFn = null) {
  return {
    name: mcpTool.name,
    description: mcpTool.description,
    parameters: toDshParameters(mcpTool.inputSchema),
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
    },
    async execute(args = {}) {
      const mergedArgs = { ...args };
      if (!mergedArgs.corpus && pluginConfig && pluginConfig.defaultCorpus) {
        mergedArgs.corpus = pluginConfig.defaultCorpus;
      }
      const callTool = handleToolCallFn || require('./mcp_server').handleToolCall;
      return await callTool(mcpTool.name, mergedArgs);
    },
  };
}

/**
 * Cordis plugin `apply(ctx, config)` entrypoint for DeepSeek Harness (`dsh`).
 */
function apply(ctx, config = {}) {
  if (config && config.corporaDir) {
    process.env.CORPORA_DIR = String(config.corporaDir);
  }
  if (config && config.defaultCorpus) {
    process.env.DEFAULT_CORPUS = String(config.defaultCorpus);
  }

  const { MCP_TOOLS, handleToolCall } = require('./mcp_server');

  let defineToolFn = (spec) => spec;
  try {
    const dshTools = require('@deepseek-ai/dsh-tools');
    if (dshTools && typeof dshTools.defineTool === 'function') {
      defineToolFn = dshTools.defineTool;
    }
  } catch (_) {
    // Fallback to raw spec object when @deepseek-ai/dsh-tools is provided by host runtime
  }

  const registered = [];
  if (ctx && ctx.tools && typeof ctx.tools.register === 'function') {
    for (const mcpTool of MCP_TOOLS) {
      const spec = defineToolFn(buildDshToolSpec(mcpTool, config, handleToolCall));
      ctx.tools.register(spec);
      registered.push(mcpTool.name);
    }
  }
  return registered;
}

module.exports = {
  name,
  inject,
  apply,
  buildDshToolSpec,
  default: {
    name,
    inject,
    apply,
  },
};
