import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

type GateEvidence = { marker: boolean; hooks: string[]; modelRequests: number };

// 错误示范：只检查模型请求会漏掉原生 !shell 的本地文件写入。
export function classifyLifecycleGate(evidence: GateEvidence) {
  if (evidence.marker || evidence.modelRequests > 0) return "bypassed";
  return "unknown";
}

// 使用系统 PTY 驱动真实 CLI；所有 HOME、配置、假密钥及目标目录均由探针独占。
// 不复制用户环境；假 provider 仅监听回环地址，不代理到远程模型。
const python = String.raw`
import os,tempfile,pathlib,threading,http.server,json,subprocess,time,pty,select,signal,shutil,sys
root=pathlib.Path(tempfile.mkdtemp(prefix='relay-lifecycle-')); (root/'project').mkdir(); (root/'home').mkdir(); (root/'config').mkdir()
requests=[]; child=None; master=None; server=None; result={}; screen=b''
class H(http.server.BaseHTTPRequestHandler):
 def do_POST(self):
  body=self.rfile.read(int(self.headers.get('content-length','0')))
  requests.append(self.path)
  self.send_response(503); self.send_header('Content-Type','application/json'); self.end_headers()
  self.wfile.write(b'{"error":{"type":"probe_rejected","message":"synthetic local endpoint"}}')
 def log_message(self,*a):pass
try:
 server=http.server.ThreadingHTTPServer(('127.0.0.1',0),H); thread=threading.Thread(target=server.serve_forever,daemon=True); thread.start()
 env={'PATH':os.environ['PATH'],'HOME':str(root/'home'),'CLAUDE_CONFIG_DIR':str(root/'config'),'ANTHROPIC_API_KEY':'relay-fake-key','ANTHROPIC_BASE_URL':f'http://127.0.0.1:{server.server_port}','CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC':'1','DISABLE_AUTOUPDATER':'1','TERM':'xterm-256color'}
 hook=root/'hook.py'; hooks=root/'hooks.jsonl'
 hook.write_text("import sys,json\nfrom pathlib import Path\nx=json.load(sys.stdin)\nwith Path(sys.argv[1]).open('a') as f:f.write(json.dumps({'event':x.get('hook_event_name'),'tool':x.get('tool_name')})+'\\n')\nsys.exit(2)\n")
 import shlex
 command=' '.join(shlex.quote(x) for x in [sys.executable,str(hook),str(hooks)])
 events=['UserPromptSubmit','UserPromptExpansion','PreToolUse','PermissionRequest','PostToolUse']
 (root/'settings.json').write_text(json.dumps({'hooks':{e:[{'hooks':[{'type':'command','command':command}]}] for e in events}}))
 (root/'config'/'.claude.json').write_text(json.dumps({'hasCompletedOnboarding':True,'theme':'dark','projects':{str(root/'project'):{'hasTrustDialogAccepted':True}}}))
 master,slave=pty.openpty()
 child=subprocess.Popen(['claude','--settings',str(root/'settings.json'),'--setting-sources','','--strict-mcp-config','--model','fake'],cwd=root/'project',env=env,stdin=slave,stdout=slave,stderr=slave,start_new_session=True); os.close(slave)
 def drain(seconds):
  global screen
  end=time.monotonic()+seconds
  while time.monotonic()<end and child.poll() is None:
   if select.select([master],[],[],.1)[0]:
    try:chunk=os.read(master,65536)
    except OSError:break
    screen+=chunk
    if b'\x1b[6n' in chunk:os.write(master,b'\x1b[1;1R')
    if b'\x1b[c' in chunk:os.write(master,b'\x1b[?1;2c')
 drain(4); os.write(master,b'\x1b[A\r'); drain(4)
 ready=b'Claude Code' in screen and child.poll() is None
 os.write(master,b'!echo lifecycle-probe > command-marker\r'); drain(5)
 result={'agent':'claude-code','version':subprocess.check_output(['claude','--version'],env=env,text=True).strip(),'ready':ready,'marker':(root/'project'/'command-marker').exists(),'hooks':[json.loads(x)['event'] for x in hooks.read_text().splitlines()] if hooks.exists() else [],'modelRequests':sum(p.split('?')[0].endswith('/messages') for p in requests),'requestPaths':requests,'scope':'real_cli_synthetic_project_local_fake_provider','temporaryRoot':str(root)}
finally:
 if child and child.poll() is None:
  os.killpg(child.pid,signal.SIGTERM)
  try:child.wait(timeout=5)
  except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait(timeout=5)
 if master is not None:os.close(master)
 if server:server.shutdown();server.server_close();thread.join(timeout=5)
 result['exitCode']=child.returncode if child else None
 result['ownedProcessExited']=child is None or child.poll() is not None
 shutil.rmtree(root)
 result['temporaryRootRemoved']=not root.exists()
print(json.dumps(result))
`;

// 失败也保存证据；由外层任务按 gate 结论决定是否允许后续实施。
export async function probeLifecycle(outputDirectory: string) {
  const child = spawn("python3", ["-c", python], {
    env: { PATH: process.env.PATH },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const code = await new Promise<number | null>((done, reject) => {
    child.once("error", reject);
    child.once("close", done);
  });
  if (code !== 0) throw new Error(`生命周期探针失败（${code}）：${stderr}`);
  const evidence = JSON.parse(stdout) as GateEvidence;
  const result = { ...evidence, gate: classifyLifecycleGate(evidence) };
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    join(outputDirectory, "claude-all-hooks.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  return result;
}

// 导入单测不运行真实 CLI；只有显式命令启动本机探针。
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const result = await probeLifecycle(
    resolve(process.argv[2] ?? ".local/evidence/direct-terminal/lifecycle-r01"),
  );
  console.log(JSON.stringify(result));
  // 此探针只查找反例，不具备证明全部入口受控的成功状态。
  process.exitCode = 1;
}
