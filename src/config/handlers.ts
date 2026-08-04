/**
 * config/handlers.ts — config 子命令处理（show / default / provider）
 *
 * 从 config.ts 拆出（issue #4）：交互式问答在 prompts.ts，
 * pi --list-models 解析在 pi-listing.ts，本模块只做子命令分发与处理。
 */

import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline";
import {
  ALL_PROVIDERS,
  readAuthFile,
  writeAuthFileNative,
  maskKey,
  findProviderDef,
} from "../providers.js";
import { readHapilonConfig, writeHapilonConfig } from "../config-io.js";
import { agentDir } from "../hapilon-home.js";
import { question, yesno } from "./prompts.js";
import { listModelsForProvider, type ParsedModel } from "../pi-listing.js";

// ─── config show ─────────────────────────────────────────────────────

function configShow(): void {
  const config = readHapilonConfig();

  if (config.defaultProvider && config.defaultModel) {
    console.log(
      `默认: --provider ${config.defaultProvider} --model ${config.defaultModel}`,
    );
  } else if (config.defaultProvider) {
    console.log(
      `默认 provider: ${config.defaultProvider}（模型未设置）`,
    );
  } else if (config.defaultModel) {
    console.log(
      `默认 model: ${config.defaultModel}（provider 未设置）`,
    );
  } else {
    console.log(
      "未设置默认配置。使用 hapilon config default --set 设置",
    );
  }
}

// ─── config default ──────────────────────────────────────────────────

async function configSetDefaultInteractive(): Promise<void> {
  if (!stdin.isTTY) {
    console.error("错误: 此命令需要交互式终端");
    process.exit(1);
  }

  const rl = createInterface({
    input: stdin,
    output: stdout,
    terminal: true,
  });

  try {
    // 1. 列出已配 auth 的 provider
    const auth = readAuthFile(agentDir());
    const configuredIds = Object.keys(auth);

    if (configuredIds.length === 0) {
      console.log(
        "未配置任何 provider。使用 hapilon config provider add <id> 添加",
      );
      return;
    }

    console.log("\n已配置 auth 的 Provider:");
    const configuredList = configuredIds
      .map((id) => {
        const def = findProviderDef(id);
        return { id, name: def?.name ?? id };
      })
      .sort((a, b) => a.id.localeCompare(b.id));

    for (let i = 0; i < configuredList.length; i++) {
      console.log(
        `  ${i + 1}. ${configuredList[i].id.padEnd(16)}(${configuredList[i].name})`,
      );
    }

    // 2. 选 provider
    const providerAnswer = (
      await question(
        rl,
        `\n选择默认 Provider [1-${configuredList.length}]: `,
      )
    ).trim();
    const providerIdx = Number.parseInt(providerAnswer, 10) - 1;
    if (
      isNaN(providerIdx) ||
      providerIdx < 0 ||
      providerIdx >= configuredList.length
    ) {
      console.error("错误: 无效的选择");
      return;
    }

    const selectedProvider = configuredList[providerIdx].id;
    const providerName =
      configuredList[providerIdx].name;

    // 3. spawn pi --list-models
    console.log(`\n正在获取 ${providerName} 模型列表...`);
    const models: ParsedModel[] = await listModelsForProvider(selectedProvider);

    if (models.length === 0) {
      console.error(`错误: 未获取到 ${providerName} 的模型列表`);
      return;
    }

    // 4. 显示模型列表
    console.log(`\n${providerName} 可用模型:`);
    for (let i = 0; i < models.length; i++) {
      console.log(
        `  ${i + 1}. ${models[i].model.padEnd(24)}(${models[i].context})`,
      );
    }

    // 5. 选模型
    const modelAnswer = (
      await question(
        rl,
        `\n选择默认模型 [1-${models.length}]: `,
      )
    ).trim();
    const modelIdx = Number.parseInt(modelAnswer, 10) - 1;
    if (isNaN(modelIdx) || modelIdx < 0 || modelIdx >= models.length) {
      console.error("错误: 无效的选择");
      return;
    }

    const selectedModel = models[modelIdx].model;

    // 6. 保存
    writeHapilonConfig({
      defaultProvider: selectedProvider,
      defaultModel: selectedModel,
    });

    console.log(
      `\n✅ 已保存: defaultProvider=${selectedProvider}, defaultModel=${selectedModel}`,
    );
  } finally {
    rl.close();
  }
}

function configUnsetDefault(): void {
  const config = readHapilonConfig();
  if (!config.defaultProvider && !config.defaultModel) {
    console.log("未设置默认配置，无需清除");
    return;
  }
  writeHapilonConfig({});
  console.log("已清除默认配置");
}

// ─── config provider list ────────────────────────────────────────────

function configProviderList(): void {
  const auth = readAuthFile(agentDir());
  const ids = Object.keys(auth);

  if (ids.length === 0) {
    console.log("未配置任何 provider");
    return;
  }

  console.log("已配置的 Provider:");
  for (const id of ids.sort()) {
    const entry = auth[id];
    const key = entry.key;
    const masked = maskKey(key);
    const def = findProviderDef(id);
    const label = def ? "" : " (custom)";
    console.log(`  ${id.padEnd(16)}${masked}${label}`);
  }
}

// ─── config provider add ─────────────────────────────────────────────

async function pickProviderFromList(
  rl: ReturnType<typeof createInterface>,
  list: { id: string; name: string }[],
  prompt: string,
): Promise<string | null> {
  console.log(`\n${prompt}:`);
  for (let i = 0; i < list.length; i++) {
    console.log(`  ${i + 1}. ${list[i].id.padEnd(20)}${list[i].name}`);
  }
  const answer = (
    await question(rl, `\n选择 [1-${list.length}]（留空取消）: `)
  ).trim();
  if (!answer) return null;
  const idx = Number.parseInt(answer, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= list.length) {
    console.error("错误: 无效的选择");
    return null;
  }
  return list[idx].id;
}

async function configProviderAdd(
  targetId: string | undefined,
): Promise<void> {
  if (!stdin.isTTY) {
    console.error("错误: 此命令需要交互式终端");
    process.exit(1);
  }

  const rl = createInterface({
    input: stdin,
    output: stdout,
    terminal: true,
  });

  try {
    let selectedId = targetId;

    // 未提供 <id> 或提供的是无效 id → 列出全部 provider 让用户选
    if (!selectedId || !findProviderDef(selectedId)) {
      if (selectedId && !findProviderDef(selectedId)) {
        console.error(`未知 provider: ${selectedId}`);
      }
      const list = ALL_PROVIDERS
        .map((p) => ({ id: p.id, name: p.name }))
        .sort((a, b) => a.id.localeCompare(b.id));
      const picked = await pickProviderFromList(rl, list, "可用的 Provider");
      if (!picked) {
        console.log("已取消");
        return;
      }
      selectedId = picked;
    }

    const def = findProviderDef(selectedId)!;
    const auth = readAuthFile(agentDir());

    if (auth[selectedId]) {
      const confirm = await yesno(
        rl,
        `${def.name} (${selectedId}) 已配置，是否覆盖？`,
      );
      if (!confirm) {
        console.log("已取消");
        return;
      }
    }

    const key = (
      await question(
        rl,
        `输入 ${def.name} API Key（留空跳过）: `,
      )
    ).trim();

    if (!key) {
      console.log("API Key 不能为空，已取消");
      return;
    }

    auth[selectedId] = { type: "api_key", key };
    writeAuthFileNative(agentDir(), auth);
    console.log(`✅ ${def.name} (${selectedId}) 已配置`);
  } finally {
    rl.close();
  }
}

// ─── config provider remove ──────────────────────────────────────────

async function configProviderRemove(
  targetId: string | undefined,
): Promise<void> {
  if (!stdin.isTTY) {
    console.error("错误: 此命令需要交互式终端");
    process.exit(1);
  }

  const rl = createInterface({
    input: stdin,
    output: stdout,
    terminal: true,
  });

  try {
    let selectedId = targetId;

    // 未提供 <id> → 列出已配置的 provider 让用户选
    if (!selectedId) {
      const auth = readAuthFile(agentDir());
      const configuredIds = Object.keys(auth).sort();
      if (configuredIds.length === 0) {
        console.log("未配置任何 provider，无需删除");
        return;
      }
      const list = configuredIds.map((id) => {
        const def = findProviderDef(id);
        return { id, name: def?.name ?? id };
      });
      const picked = await pickProviderFromList(rl, list, "已配置的 Provider");
      if (!picked) {
        console.log("已取消");
        return;
      }
      selectedId = picked;
    }

    const auth = readAuthFile(agentDir());

    if (!auth[selectedId]) {
      console.error(`错误: ${selectedId} 未配置`);
      return;
    }

    const def = findProviderDef(selectedId);
    const name = def?.name ?? selectedId;

    const confirm = await yesno(
      rl,
      `${name} (${selectedId}) 将被删除。确认？`,
    );

    if (!confirm) {
      console.log("已取消");
      return;
    }

    delete auth[selectedId];
    writeAuthFileNative(agentDir(), auth);
    console.log(`已删除 ${name} (${selectedId})`);
  } finally {
    rl.close();
  }
}

// ─── Router ──────────────────────────────────────────────────────────

export async function handleConfig(args: string[]): Promise<void> {
  const subcommand = args[1];

  if (!subcommand || subcommand === "show") {
    configShow();
    return;
  }

  if (subcommand === "default") {
    const action = args[2];
    if (action === "--set") {
      await configSetDefaultInteractive();
    } else if (action === "--unset") {
      configUnsetDefault();
    } else {
      console.error("请指定 --set 或 --unset");
      console.error(
        "用法: hapilon config default --set | --unset",
      );
      process.exit(1);
    }
    return;
  }

  if (subcommand === "provider") {
    const action = args[2];
    if (action === "list") {
      configProviderList();
    } else if (action === "add") {
      await configProviderAdd(args[3]);
    } else if (action === "remove") {
      await configProviderRemove(args[3]);
    } else {
      console.error(
        "用法: hapilon config provider list | add <id> | remove <id>",
      );
      process.exit(1);
    }
    return;
  }

  console.error(`未知 config 子命令: ${subcommand}`);
  console.error("输入 hapilon help config 查看帮助");
  process.exit(1);
}
