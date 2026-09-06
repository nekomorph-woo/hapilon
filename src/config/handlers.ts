/**
 * config/handlers.ts — config 子命令处理（show / provider）
 *
 * 从 config.ts 拆出（issue #4）：交互式问答在 prompts.ts，
 * pi --list-models 解析在 pi-listing.ts，本模块只做子命令分发与处理。
 */

import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline";
import { Effect } from "effect";
import {
  ALL_PROVIDERS,
  readAuthFileEffect,
  writeAuthFileNativeEffect,
  maskKey,
  findProviderDef,
} from "../providers/providers.js";
import { agentDir } from "./hapilon-home.js";
import { question, yesno } from "./prompts.js";
import { deriveCliIdentity } from "../cli/identity.js";

// ─── config show ─────────────────────────────────────────────────────

function configShow(): void {
  console.log("默认 provider/model 由 Pi 原生 agent/settings.json 管理，请在 Pi 的 /model 中使用 Ctrl+S 保存。");
}

// ─── config provider list ────────────────────────────────────────────

function configProviderList(): void {
  const auth = Effect.runSync(readAuthFileEffect(agentDir()));
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
    const auth = Effect.runSync(readAuthFileEffect(agentDir()));

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
    Effect.runSync(writeAuthFileNativeEffect(agentDir(), auth));
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
      const auth = Effect.runSync(readAuthFileEffect(agentDir()));
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

    const auth = Effect.runSync(readAuthFileEffect(agentDir()));

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
    Effect.runSync(writeAuthFileNativeEffect(agentDir(), auth));
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
        `用法: ${deriveCliIdentity().cliName} config provider list | add <id> | remove <id>`,
      );
      process.exit(1);
    }
    return;
  }

  console.error(`未知 config 子命令: ${subcommand}`);
  console.error(`输入 ${deriveCliIdentity().cliName} help config 查看帮助`);
  process.exit(1);
}
