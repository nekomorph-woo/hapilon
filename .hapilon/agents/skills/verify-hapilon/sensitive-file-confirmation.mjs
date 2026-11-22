#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { constants, accessSync, appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const cli = join(repo, 'dist/cli.js');
const version = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version;
const feature = 'sensitive-file-confirmation';
const provider = 'verify-local';
const model = 'fixture';
const marker = `HAPI_VERIFY_FAKE_${process.pid}`;
const doctor = process.argv[2] === '--doctor';
assert.ok(process.argv.length === 2 || (process.argv.length === 3 && doctor),
  `用法：${feature}.mjs [--doctor]`);
assert.ok(process.getuid?.() > 0, '请用非 root 的 POSIX 账号运行，保证不可读夹具的权限生效');
assert.equal(execFileSync(process.execPath, [cli, '--version'], { encoding: 'utf8' }).trim(), version);
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
const evidenceDir = join(repo, '.hapilon/verify');
mkdirSync(evidenceDir, { recursive: true });
const evidence = join(mkdtempSync(join(evidenceDir, `${doctor ? 'doctor' : feature}-`)), 'events.jsonl');
const record = (event) => appendFileSync(evidence, `${JSON.stringify(event)}\n`);
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'hapi-verify-')));
const workspace = join(scratch, 'workspace');
const home = join(scratch, 'home');
const agent = join(home, '.hapilon/agent');
let active;
let child;
let endpointError;
let closing = false;
const pending = new Map();
let sequence = 0;
let ioError;
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/chat/completions');
    const data = [];
    for await (const chunk of req) data.push(chunk);
    const request = JSON.parse(Buffer.concat(data).toString('utf8'));
    assert.equal(request.model, model);
    assert.ok(active, '收到不属于当前用例的模型请求');
    const result = request.messages.filter((message) => message.role === 'tool');
    const leaked = JSON.stringify(request).includes(marker);
    active.leaked ||= leaked;
    active.modelResults.push(...result);
    record({ type: 'model-input', case: active.id, results: result, containsFixtureMarker: leaked });
    const reply = result.length === 0
      ? { tool_calls: [{ index: 0, id: 'call_fixture', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: active.command }) } }] }
      : { content: 'FIXTURE_DONE' };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta: { role: 'assistant', ...reply }, finish_reason: result.length === 0 ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
  } catch (error) {
    endpointError = error;
    res.writeHead(500).end('fixture endpoint error');
  }
});

function bounded(promise, label, ms = 20_000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时`)), ms);
  })]).finally(() => clearTimeout(timer));
}

function send(message) {
  if (ioError) throw ioError;
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function rpc(type, payload = {}) {
  const id = String(++sequence);
  return bounded(new Promise((resolve) => {
    pending.set(id, resolve);
    send({ id, type, ...payload });
  }), type).then((response) => {
    assert.equal(response.success, true, JSON.stringify(response));
    return response.data;
  }).finally(() => pending.delete(id));
}

function onEvent(event) {
  if (event.type === 'response') pending.get(event.id)?.(event);
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

async function launch() {
  mkdirSync(agent, { recursive: true });
  mkdirSync(workspace);
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { [provider]: {
    baseUrl, api: 'openai-completions', apiKey: 'fixture-not-a-key', models: [{ id: model }],
  } } }));
  writeFileSync(join(agent, 'settings.json'), JSON.stringify({
    retry: { enabled: false },
    'pi-browser-use': { envAllowlist: ['CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS'] },
  }));
  child = spawn(process.execPath, [cli, '--mode', 'rpc', '--no-session', '--no-mcp', '--no-econ', '--tools', 'bash', '--provider', provider, '--model', model], {
    cwd: workspace, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      HOME: home, HAPILON_HOME: dirname(agent), PATH: process.env.PATH, TMPDIR: scratch,
      XDG_CONFIG_HOME: join(home, '.config'), CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1',
    },
  });
  child.once('error', (error) => { ioError = error; });
  child.once('exit', (code, signal) => {
    if (!closing) ioError = new Error(`hapi 提前退出：${code ?? signal}`);
  });
  child.stdin.on('error', (error) => { ioError = error; });
  child.stderr.setEncoding('utf8').on('data', (text) => record({ type: 'stderr', text }));
  createInterface({ input: child.stdout }).on('line', (line) => {
    try {
      if (line.startsWith('{')) onEvent(JSON.parse(line));
      else record({ type: 'startup-output', line });
    } catch (error) {
      ioError = error;
      record({ type: 'rpc-error', message: error.message });
    }
  });
  const state = await rpc('get_state');
  assert.equal(state.model?.provider, provider);
  assert.equal(state.model?.id, model);
  assert.equal(state.model?.baseUrl, baseUrl);
  assert.equal(state.isStreaming, false);
  const available = await rpc('get_commands');
  assert.ok(available.commands.some(({ name }) => name === 'gate-auto-mode'), '安全门扩展未加载');
  record({ type: 'ready', cli, version, pid: child.pid, workspace, model: state.model.id, baseUrl });
}

function seed() {
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

async function drive(fixture) {
  const session = await rpc('new_session');
  assert.equal(session.cancelled, false);
  const settled = new Promise((finish) => {
    active = { ...fixture, finish, prompts: [], calls: [], toolErrors: [], modelResults: [], leaked: false };
  });
  record({ type: 'case', ...fixture });
  await rpc('prompt', { message: `验收用例 ${fixture.id}。由本地模型夹具选择命令。` });
  assert.equal((await bounded(settled, fixture.id)).aborted, false);
  if (ioError || endpointError) throw ioError ?? endpointError;
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

try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  execFileSync('cc', ['--version'], { timeout: 10_000 });
  await launch();
  if (!doctor) {
    seed();
    let ok = true;
    for (const fixture of cases) if (!(await drive(fixture))) ok = false;
    if (!ok) process.exitCode = 1;
  }
} catch (error) {
  record({ type: 'harness-error', message: error.message });
  console.error(error);
  process.exitCode = 2;
} finally {
  closing = true;
  try {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.stdin.end();
      try {
        await bounded(exited, '退出 hapi', 3_000);
      } catch (error) {
        record({ type: 'cleanup-timeout', message: error.message });
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
        await bounded(exited, '结束 hapi 进程组', 3_000);
        process.exitCode = 2;
      }
    }
  } finally {
    server.closeAllConnections();
    server.close();
    rmSync(scratch, { recursive: true });
    record({ type: 'cleaned', scratch });
    accessSync(evidence, constants.R_OK);
    console.log(`证据：${evidence}`);
  }
}
