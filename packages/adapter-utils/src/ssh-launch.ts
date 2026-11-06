// Fixed bootstrap only: all invocation data travels in a private stdin frame.
// Keep the channel open after the frame: EOF means transport loss, not command
// stdin EOF (the latter is carried independently inside the frame).
const pythonLauncher = String.raw`
import json, os, signal, subprocess, sys, threading
frame = b''
while b'\n' not in frame:
    chunk = os.read(0, 65536)
    if not chunk: sys.exit(125)
    frame += chunk
p = json.loads(frame.split(b'\n', 1)[0])
env = dict(os.environ, **p['env'])
child = subprocess.Popen([p['command']] + p['args'], cwd=p.get('cwd'), env=env, stdin=subprocess.PIPE, start_new_session=True)
lock = threading.Lock()
stopped = threading.Event()
def stop(*_):
    if not lock.acquire(False): return
    try:
        try: os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError: return
        threading.Event().wait(p['graceSec'])
        try: os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError: pass
    finally: stopped.set(); lock.release()
def disconnected():
    while os.read(0, 4096): pass
    stop()
for sig in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT): signal.signal(sig, stop)
threading.Thread(target=disconnected, daemon=True).start()
if p['timeoutSec'] > 0:
    timer = threading.Timer(p['timeoutSec'], stop)
    timer.daemon = True
    timer.start()
def feed():
    try: child.stdin.write(p['stdin'].encode('utf-8')); child.stdin.close()
    except (BrokenPipeError, OSError): pass
threading.Thread(target=feed, daemon=True).start()
code = child.wait()
# Descendants must not outlive the invocation, including after a clean exit.
stop()
stopped.wait()
sys.exit(code if code >= 0 else 128 - code)
`;

export const nodeLauncher = String.raw`
const { spawn } = require('node:child_process');
let frame = Buffer.alloc(0), child, stopping = false, timer;
const stop = () => {
  if (!child || stopping) return;
  stopping = true;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { return; }
  timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, payload.graceSec * 1000);
};
let payload;
process.stdin.on('data', chunk => {
  if (child) return;
  frame = Buffer.concat([frame, chunk]);
  const end = frame.indexOf(10);
  if (end < 0) return;
  payload = JSON.parse(frame.subarray(0, end).toString('utf8'));
  frame = null;
  child = spawn(payload.command, payload.args, { cwd: payload.cwd || undefined, env: { ...process.env, ...payload.env }, detached: true, stdio: ['pipe', 'inherit', 'inherit'] });
  child.stdin.on('error', () => {});
  child.stdin.end(payload.stdin);
  child.on('error', () => { console.error('SSH remote command could not start'); process.exitCode = 127; process.stdin.destroy(); });
  child.on('exit', (code, signal) => { stop(); process.exitCode = code ?? (signal ? 128 : 1); process.stdin.destroy(); });
  if (payload.timeoutSec > 0) setTimeout(stop, payload.timeoutSec * 1000).unref();
});
process.stdin.on('end', stop);
for (const sig of ['SIGHUP', 'SIGTERM', 'SIGINT']) process.on(sig, stop);
`;

function quote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function sshLaunchCommand(): string {
  return `sh -c ${quote([
    'if [ -f /etc/profile ]; then . /etc/profile </dev/null >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.profile" ]; then . "$HOME/.profile" </dev/null >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile" </dev/null >/dev/null 2>&1 || true; elif [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc" </dev/null >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.zprofile" ]; then . "$HOME/.zprofile" </dev/null >/dev/null 2>&1 || true; fi',
    `if command -v python3 >/dev/null 2>&1; then exec python3 -c ${quote(pythonLauncher)}; elif command -v node >/dev/null 2>&1; then exec node -e ${quote(nodeLauncher)}; else echo 'SSH execution requires python3 or node on the target' >&2; exit 127; fi`,
  ].join('\n'))}`;
}

export function sshLaunchFrame(input: {
  command: string; args: string[]; env: Record<string, string>;
  cwd?: string; stdin?: string; timeoutSec?: number; graceSec?: number;
}): string {
  return JSON.stringify({ ...input, stdin: input.stdin ?? '', timeoutSec: input.timeoutSec ?? 0, graceSec: Math.max(0, input.graceSec ?? 5) }) + '\n';
}
