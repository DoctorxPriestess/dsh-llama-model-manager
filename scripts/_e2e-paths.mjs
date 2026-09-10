/**
 * Resolve the paths the e2e scripts need, WITHOUT hardcoding anything.
 *
 * Order of preference:
 *   1. environment variables (LLAMA_SERVER_PATH / LLAMA_MODEL) -- lets CI or a
 *      one-off run point somewhere specific;
 *   2. the plugin's own config file, which is where a real installation already
 *      records both paths.
 *
 * The e2e scripts load a real model (tens of seconds, several GB of VRAM), so
 * they are deliberately NOT part of `npm test`.
 */
import fs from 'node:fs';

import { loadConfig, resolveConfigPath } from '../src/core/config.js';

/**
 * @param {{configPath?: string}} [options]
 * @returns {{exePath: string|null, modelPath: string|null, modelId: string|null, source: string, configPath: string, problem: string|null}}
 */
export function resolveE2ePaths({ configPath = resolveConfigPath() } = {}) {
  let settings = {};
  let models = {};
  let configReadable = false;
  try {
    const loaded = loadConfig(configPath);
    settings = loaded.config.settings ?? {};
    models = loaded.config.models ?? {};
    configReadable = true;
  } catch {
    configReadable = false;
  }

  const envExe = process.env.LLAMA_SERVER_PATH || '';
  const envModel = process.env.LLAMA_MODEL || '';
  const envModelId = process.env.LLAMA_MODEL_ID || '';

  const exePath = envExe || settings.llamaServerPath || '';
  let modelPath = envModel;
  let modelId = envModelId || null;

  if (!modelPath) {
    // Prefer the model the installation would actually start first.
    const preferred = settings.startupModel && models[settings.startupModel] ? settings.startupModel : null;
    const entry = preferred
      ? [preferred, models[preferred]]
      : Object.entries(models).find(([, m]) => m && m.modelPath);
    if (entry) {
      modelId = modelId ?? entry[0];
      modelPath = entry[1]?.modelPath ?? '';
    }
  } else if (!modelId) {
    const match = Object.entries(models).find(([, m]) => m && m.modelPath === modelPath);
    modelId = match ? match[0] : null;
  }

  const source = envExe || envModel ? 'environment variables' : `plugin config (${configPath})`;

  let problem = null;
  if (!exePath) problem = 'no llama-server path (set LLAMA_SERVER_PATH or configure the plugin)';
  else if (!fs.existsSync(exePath)) problem = `llama-server not found at ${exePath}`;
  else if (!modelPath) problem = 'no .gguf selected (set LLAMA_MODEL or add a model in the plugin settings)';
  else if (!fs.existsSync(modelPath)) problem = `model file not found at ${modelPath}`;

  return {
    exePath: exePath || null,
    modelPath: modelPath || null,
    modelId,
    source,
    configPath,
    configReadable,
    problem,
  };
}

/** Print the resolved paths and exit(2) with a clear message when unusable. */
export function requireE2ePaths() {
  const paths = resolveE2ePaths();
  console.log('llama-server :', paths.exePath ?? '(unresolved)');
  console.log('.gguf        :', paths.modelPath ?? '(unresolved)');
  console.log('model id     :', paths.modelId ?? '(none)');
  console.log('resolved via :', paths.source);
  if (paths.problem) {
    console.error(`\nCannot run this end-to-end script: ${paths.problem}`);
    console.error('Set LLAMA_SERVER_PATH and LLAMA_MODEL, or configure the plugin first.');
    process.exit(2);
  }
  return paths;
}
