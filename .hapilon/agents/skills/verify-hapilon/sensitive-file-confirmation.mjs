#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants, accessSync, chmodSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bounded, repo, withRpcVerification } from './rpc-verification.mjs';

const feature = 'sensitive-file-confirmation';
const marker = `HAPI_VERIFY_FAKE_${process.pid}`;
const doctor = process.argv[2] === '--doctor';
assert.ok(process.argv.length === 2 || (process.argv.length === 3 && doctor),
  `用法：${feature}.mjs [--doctor]`);
assert.ok(process.getuid?.() > 0, '请用非 root 的 POSIX 账号运行，保证不可读夹具的权限生效');
const { READ_CONFIRM } = await import(pathToFileURL(join(repo, 'dist/extensions/hpl-protected-paths/rules.js')));

const cases = [
  { id: 'listing-control', command: 'ls -ld .env demo.kubeconfig', output: 'demo.kubeconfig' },
  { id: 'inline-data', command: ['node --input-type=module <<\'JS\'', 'const sample = [ \'.env\', \'demo.kubeconfig\' ];', 'console.log(sample.length === 2 ? "INLINE_OK" : "BAD");', 'JS'].join('\n'), output: 'INLINE_OK' },
  { id: 'metadata', command: 'stat .env', output: '.env' },
  { id: 'text-no-disclosure', command: 'bash ./quiet.sh .env', output: 'TEXT_OK' },
  { id: 'binary-no-disclosure', command: './quiet-bin .env', output: 'BINARY_OK' },
  { id: 'text-disclosure', command: 'bash ./show.sh .env', confirm: true },
  { id: 'unreadable', command: './unreadable.sh .env', confirm: true },
  { id: 'direct-read', command: 'cat .env', confirm: true },
];
let active;

function reply(request, record) {
  assert.ok(active, '收到不属于当前用例的模型请求');
  const result = request.messages.filter((message) => message.role === 'tool');
  const leaked = JSON.stringify(request).includes(marker);
  active.leaked ||= leaked;
  active.modelResults.push(...result);
  record({ type: 'model-input', case: active.id, results: result, containsFixtureMarker: leaked });
  const reply = result.length === 0
    ? { tool_calls: [{ index: 0, id: 'call_fixture', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: active.command }) } }] }
    : { content: 'FIXTURE_DONE' };
  return { delta: reply, finishReason: result.length === 0 ? 'tool_calls' : 'stop' };
}

function onEvent(event, { send, record }) {
  if (!active) return;
  if (['tool_execution_start', 'tool_execution_end', 'extension_ui_request', 'agent_settled'].includes(event.type)) {
    record({ type: 'rpc', case: active.id, event });
  }
  if (event.type === 'extension_ui_request' && ['select', 'confirm', 'input', 'editor'].includes(event.method)) {
    active.prompts.push(event);
    const response = event.method === 'select' && event.options.includes('Deny') ? { value: 'Deny' } : { cancelled: true };
    record({ type: 'decline', case: active.id, id: event.id, ...response });
    send({ type: 'extension_ui_response', id: event.id, ...response });
  }
  if (event.type === 'tool_execution_start' && event.toolName === 'bash') active.calls.push(event.args?.command);
  if (event.type === 'tool_execution_end' && event.toolName === 'bash') active.toolErrors.push(event.isError);
  if (event.type === 'agent_settled') active.finish(event);
}

function seed(workspace) {
  for (const name of ['.env', 'demo.kubeconfig']) {
    const path = join(workspace, name);
    assert.ok(READ_CONFIRM.some(({ test }) => test(path)), `夹具未命中现有读保护规则：${name}`);
    writeFileSync(path, `${marker}\n`, { mode: 0o600 });
  }
  writeFileSync(join(workspace, 'quiet.sh'), 'IFS= read -r line < "$1" && printf "TEXT_OK\\n"\n');
  writeFileSync(join(workspace, 'show.sh'), 'cat "$1"\n');
  const unreadable = join(workspace, 'unreadable.sh');
  writeFileSync(unreadable, '#!/bin/sh\nexit 0\n');
  chmodSync(unreadable, 0o100);
  assert.throws(() => accessSync(unreadable, constants.R_OK), { code: 'EACCES' });
  const source = join(workspace, 'quiet.c');
  writeFileSync(source, '#include <stdio.h>\nint main(int argc, char **argv) {\n  if (argc != 2) return 1;\n  FILE *f = fopen(argv[1], "r");\n  if (!f) return 1;\n  int c = fgetc(f);\n  fclose(f);\n  if (c == EOF) return 1;\n  puts("BINARY_OK");\n  return 0;\n}\n');
  execFileSync('cc', [source, '-o', join(workspace, 'quiet-bin')], { timeout: 10_000, stdio: 'pipe' });
  rmSync(source);
}

async function drive(fixture, { checkIo, record, rpc }) {
  const session = await rpc('new_session');
  assert.equal(session.cancelled, false);
  const settled = new Promise((finish) => {
    active = { ...fixture, finish, prompts: [], calls: [], toolErrors: [], modelResults: [], leaked: false };
  });
  record({ type: 'case', ...fixture });
  await rpc('prompt', { message: `验收用例 ${fixture.id}。由本地模型夹具选择命令。` });
  assert.equal((await bounded(settled, fixture.id)).aborted, false);
  checkIo();
  assert.deepEqual(active.calls, [fixture.command], `${fixture.id} 没有通过实际 Bash 工具发出一次命令`);
  assert.equal(active.modelResults.length, 1, `${fixture.id} 未捕获恰好一次模型可见工具结果`);
  assert.equal(active.toolErrors.length, 1, `${fixture.id} 未捕获恰好一次工具结束事件`);
  const output = JSON.stringify(active.modelResults[0].content);
  const expectConfirm = fixture.confirm === true;
  const expectedPrompts = Number(expectConfirm);
  const resultMatches = expectConfirm ? output.includes('用户拒绝了敏感文件读取') : output.includes(fixture.output);
  const ok = active.prompts.length === expectedPrompts && resultMatches && !active.leaked
    && active.toolErrors[0] === expectConfirm
    && active.prompts.every(({ title }) => title.startsWith('⚠️ 敏感文件读取确认'));
  record({ type: 'verdict', case: fixture.id, expectedPrompts, actualPrompts: active.prompts.length,
    resultMatches, toolError: active.toolErrors[0], containsFixtureMarker: active.leaked, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${fixture.id}（确认 ${active.prompts.length}/${expectedPrompts}）`);
  active = undefined;
  return ok;
}

execFileSync('cc', ['--version'], { timeout: 10_000 });
await withRpcVerification({ name: doctor ? 'doctor' : feature, tools: ['bash'], reply, onEvent }, async (env) => {
  const available = await env.rpc('get_commands');
  assert.ok(available.commands.some(({ name }) => name === 'gate-auto-mode'), '安全门扩展未加载');
  if (doctor) return;
  seed(env.workspace);
  let ok = true;
  for (const fixture of cases) if (!(await drive(fixture, env))) ok = false;
  if (!ok) process.exitCode = 1;
});
