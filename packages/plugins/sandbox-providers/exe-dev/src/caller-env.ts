// Caller env (which carries the agent's PAPERCLIP_API_KEY) must never appear in
// a process argv or in the command text handed to the provider (BLA-3999). This
// is the BLA-3978 (PR #59) pattern for the e2b and modal providers: the values
// travel as a POSIX script outside every command string, are applied in a fresh
// `/bin/sh` that has sourced no profile, and only names and paths reach argv.
// Each provider plugin ships on its own, so this file is copied per provider,
// as PR #59 did. Keep the createos and exe-dev copies identical.

function quote(value: string): string {
  // An env value cannot hold NUL (execve would cut it), so reject it rather
  // than deliver a different value.
  if (value.includes("\0")) throw new Error("Sandbox environment values cannot contain NUL.");
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

// Interpreter execve helpers, used only when `env -S` is unavailable. Both
// read each value from its `__paperclip_env_<i>` alias in their own environment,
// set it under the caller's name, drop the alias, and execvp the target; only
// the name count and names are in their argv. Neither contains a single quote.
const CALLER_ENV_PERL_EXEC =
  'my $c=shift @ARGV; my @n=splice(@ARGV,0,$c); for my $i (0..$#n) { $ENV{$n[$i]}=delete $ENV{"__paperclip_env_$i"}; } exec { $ARGV[0] } @ARGV; print STDERR "paperclip-env: $ARGV[0]: $!\\n"; exit 127;';
const CALLER_ENV_PYTHON_EXEC = [
  "import os,sys",
  "a=sys.argv[1:];c=int(a[0]);n=a[1:1+c];a=a[1+c:]",
  'for i,k in enumerate(n): os.environ[k]=os.environ.pop("__paperclip_env_%d"%i)',
  "try: os.execvp(a[0],a)",
  "except OSError as e:",
  '  sys.stderr.write("paperclip-env: %s: %s\\n"%(a[0],e.strerror)); sys.exit(127)',
].join("\n");

// `__paperclip_env_run "$@"` applies the aliases under the caller's names and
// execs the target. Profiles can mark names readonly; the fresh shell inherits
// only their exported values, not that attribute. If `/bin/sh` itself refuses
// a caller name (bash owns readonly UID, EUID, PPID, BASHOPTS, SHELLOPTS and
// BASH_VERSINFO even as `sh --posix`), the trial in a subshell fails and the
// env is applied without shell assignment, so every name `exec env K=v` used to
// accept still reaches the child (BLA-4033). GNU coreutils `env -S` expands
// each `${__paperclip_env_<i>}` from its own environment, so its kernel argv
// holds only names. Where `env` lacks `-S` (for example busybox), a perl or
// python3 execve helper does the same. Only when the shell refuses a name and
// none of these exists does it fail, loudly, with exit 126. It lives in the
// staged script, not the command text, so the command stays one short line.
const CALLER_ENV_RUN_FUNCTION = [
  "__paperclip_env_run() {",
  'if ( __paperclip_env_apply ) >/dev/null 2>&1; then __paperclip_env_apply || exit 125; __paperclip_env_unset; exec "$@"; fi',
  "__paperclip_env_export",
  'if env -S -i >/dev/null 2>&1; then exec env -S "$__paperclip_env_split" "$@"; fi',
  `if command -v perl >/dev/null 2>&1; then exec perl -e ${quote(CALLER_ENV_PERL_EXEC)} $__paperclip_env_names "$@"; fi`,
  `if command -v python3 >/dev/null 2>&1; then exec python3 -I -c ${quote(CALLER_ENV_PYTHON_EXEC)} $__paperclip_env_names "$@"; fi`,
  'echo "paperclip-env: /bin/sh refuses a caller env name and no env -S, perl or python3 is available" >&2',
  "exit 126",
  "}",
];

/**
 * Render caller env as a POSIX script. Each value is held in a private alias
 * (`__paperclip_env_<i>`); single-quoting keeps the exact bytes, including
 * quotes, newlines and `$`. Names must already be validated identifiers; they
 * are not secret. Returns null when there is nothing to send.
 */
export function buildCallerEnvScript(entries: Array<[string, string]>): string | null {
  if (entries.length === 0) return null;
  const aliases = entries.map((_, index) => `__paperclip_env_${index}`);
  const lines = [
    ...entries.map(([, value], index) => `${aliases[index]}=${quote(value)}`),
    `__paperclip_env_apply() { ${entries.map(([key], index) => `export ${key}="$${aliases[index]}"`).join(" && ")}; }`,
    `__paperclip_env_export() { export ${aliases.join(" ")}; }`,
    `__paperclip_env_unset() { unset ${aliases.join(" ")}; }`,
    `__paperclip_env_names=${quote(`${entries.length} ${entries.map(([key]) => key).join(" ")}`)}`,
    // `env -S` arguments: drop the aliases, then set each caller name from its
    // alias. GNU env expands `${alias}` from its own environment, so values
    // never enter argv. Contains only names.
    `__paperclip_env_split=${quote(
      `${aliases.map((alias) => `-u ${alias}`).join(" ")} -- ${entries.map(([key], index) => `${key}=\${${aliases[index]}}`).join(" ")}`,
    )}`,
    ...CALLER_ENV_RUN_FUNCTION,
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * Fresh-shell body for a staged env FILE: `$1` is the file path; it is sourced,
 * removed before exec, and the rest of argv is the target. Only the path is in
 * argv. Tracing is switched off first so an inherited `SHELLOPTS` cannot print
 * the assignments. Use as `/bin/sh -c BODY paperclip-env <path> <cmd> <args…>`.
 */
export const CALLER_ENV_FILE_EXEC = 'set +xv; . "$1" || exit 125; { rm -f "$1" || true; }; shift; __paperclip_env_run "$@"';

/**
 * Fresh-shell body for a script carried in the exported `__pc_env` variable
 * (the exe-dev stdin header). The variable is dropped before the target runs.
 * Use as `/bin/sh -c BODY paperclip-env <cmd> <args…>`.
 */
export const CALLER_ENV_VAR_EXEC = 'set +xv; eval "$__pc_env" || exit 125; unset __pc_env; __paperclip_env_run "$@"';
