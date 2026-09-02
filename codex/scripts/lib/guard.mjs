import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

const MAX_COMMAND_BYTES = 128 * 1024;
const MAX_TOKENS = 1024;
const MAX_NESTING = 5;
const SUPPORTED_TOOLS = new Set(["Bash", "apply_patch"]);
const RULE_RANK = new Map([
  ["malformed-input", 0],
  ["encoded-command", 1],
  ["system-destructive", 2],
  ["git-destructive", 3],
  ["protected-root", 4],
  ["sensitive-path", 5],
  ["dynamic-target", 6],
  ["patch-outside-workspace", 7],
  ["patch-sensitive-path", 8],
  ["no-match", 9]
]);

const SYSTEM_COMMANDS = new Set([
  "clear-disk",
  "diskpart",
  "fdisk",
  "format",
  "format-volume",
  "halt",
  "initialize-disk",
  "mkfs",
  "parted",
  "poweroff",
  "reboot",
  "remove-partition",
  "restart-computer",
  "sfdisk",
  "shutdown",
  "stop-computer",
  "wipefs"
]);
const FILE_MUTATORS = new Set([
  "add-content",
  "chmod",
  "chown",
  "clear-content",
  "copy",
  "copy-item",
  "cp",
  "del",
  "erase",
  "icacls",
  "move",
  "move-item",
  "mv",
  "out-file",
  "rd",
  "remove-item",
  "rename-item",
  "ri",
  "rm",
  "rmdir",
  "set-acl",
  "set-content",
  "takeown",
  "truncate",
  "unlink"
]);
const NESTED_SHELLS = new Set(["bash", "dash", "sh", "zsh"]);
const POWERSHELLS = new Set(["powershell", "pwsh"]);
const WRAPPERS = new Set(["builtin", "command", "doas", "exec", "nohup", "sudo"]);
const CMD_SWITCHES = new Set(["/a", "/d", "/f", "/i", "/n", "/q", "/s"]);
const POWERSHELL_PATH_COMMANDS = new Set([
  "add-content",
  "clear-content",
  "copy-item",
  "move-item",
  "out-file",
  "remove-item",
  "rename-item",
  "ri",
  "set-content"
]);
const POWERSHELL_CONTENT_COMMANDS = new Set([
  "add-content",
  "clear-content",
  "out-file",
  "set-content"
]);
const POWERSHELL_PATH_PARAMETERS = new Set([
  "destination",
  "filepath",
  "literalpath",
  "newname",
  "path",
  "target"
]);
const POWERSHELL_VALUE_PARAMETERS = new Set([
  "credential",
  "delimiter",
  "encoding",
  "erroraction",
  "errorvariable",
  "exclude",
  "filter",
  "include",
  "informationaction",
  "informationvariable",
  "outbuffer",
  "outvariable",
  "pipelinevariable",
  "stream",
  "value",
  "warningaction",
  "warningvariable"
]);
const SENSITIVE_DIRECTORIES = new Set([
  ".aws",
  ".azure",
  ".codex",
  ".git",
  ".gnupg",
  ".ssh"
]);
const SENSITIVE_FILES = new Set([
  ".bash_profile",
  ".bashrc",
  ".env",
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".profile",
  ".zprofile",
  ".zshrc",
  "authorized_keys",
  "credentials",
  "credentials.json",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
  "known_hosts",
  "microsoft.powershell_profile.ps1"
]);
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function plainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function chooseRule(rules) {
  let selected = "no-match";
  for (const rule of rules) {
    if ((RULE_RANK.get(rule) ?? Infinity) < RULE_RANK.get(selected)) selected = rule;
  }
  return selected;
}

export function deny(ruleId) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `Harness50 blocked this operation (rule: ${ruleId}).`
    }
  };
}

const KNOWN_EXECUTABLES = new Set([
  ...SYSTEM_COMMANDS,
  ...FILE_MUTATORS,
  ...NESTED_SHELLS,
  ...POWERSHELLS,
  ...WRAPPERS,
  "cmd",
  "dd",
  "env",
  "git"
]);

function basenameExecutable(value) {
  const unwrapped = value.replace(/^[({]+|[)}]+$/g, "");
  const name = unwrapped.split(/[\\/]/).at(-1).toLowerCase();
  return name.endsWith(".exe") || name.endsWith(".com") ? name.slice(0, -4) : name;
}

function executableName(value) {
  const direct = basenameExecutable(value);
  if (KNOWN_EXECUTABLES.has(direct) || direct.startsWith("mkfs.")) return direct;
  const decoded = value
    .replace(/\\(.)/gs, "$1")
    .replace(/\^(.)/gs, "$1")
    .replace(/`(.)/gs, "$1");
  const candidate = basenameExecutable(decoded);
  return KNOWN_EXECUTABLES.has(candidate) || candidate.startsWith("mkfs.")
    ? candidate
    : direct;
}

function pushToken(tokens, token) {
  if (token !== "") tokens.push(token);
  if (tokens.length > MAX_TOKENS) throw new Error("too many shell tokens");
}

function substitutionEnd(command, start) {
  let depth = 0;
  let quote = null;
  for (let index = start + 1; index < command.length; index += 1) {
    const character = command[index];
    if (quote !== null) {
      if (character === quote) quote = null;
      else if (character === "\\" && quote === '"') index += 1;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "(") depth += 1;
    if (character === ")") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  throw new Error("unterminated command substitution");
}

function lexShell(command) {
  if (Buffer.byteLength(command, "utf8") > MAX_COMMAND_BYTES || command.includes("\0")) {
    throw new Error("shell input is outside the bounded parser contract");
  }
  const commands = [];
  let tokens = [];
  let token = "";
  let quote = null;
  let index = 0;
  let receivesPipeline = false;
  const endCommand = separator => {
    pushToken(tokens, token);
    token = "";
    const hadTokens = tokens.length > 0;
    if (hadTokens) commands.push({ tokens, receivesPipeline });
    tokens = [];
    if (separator !== undefined && (hadTokens || separator === "pipe")) {
      receivesPipeline = separator === "pipe";
    }
  };

  while (index < command.length) {
    const character = command[index];
    if (quote === "'") {
      if (character === "'") quote = null;
      else token += character;
      index += 1;
      continue;
    }
    if (quote === '"') {
      if (character === '"') {
        quote = null;
      } else if (
        character === "\\" &&
        command[index + 1] === '"' &&
        /(?:^|\s)(?:[A-Za-z]:|\\\\[^\s]+)$/.test(token)
      ) {
        token += character;
      } else if (character === "\\" && /["\\$`]/.test(command[index + 1] ?? "")) {
        token += command[index + 1];
        index += 1;
      } else {
        token += character;
      }
      index += 1;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      index += 1;
      continue;
    }
    if (character === "$" && command[index + 1] === "(") {
      const end = substitutionEnd(command, index);
      token += command.slice(index, end);
      index = end;
      continue;
    }
    if (character === "#" && token === "" && tokens.length > 0) {
      while (index < command.length && command[index] !== "\n") index += 1;
      continue;
    }
    if (/\s/.test(character)) {
      pushToken(tokens, token);
      token = "";
      if (character === "\n" || character === "\r") endCommand("other");
      index += 1;
      continue;
    }
    if (character === "(" || character === ")") {
      endCommand("other");
      index += 1;
      continue;
    }
    if ((character === "{" || character === "}") && token === "") {
      endCommand("other");
      index += 1;
      continue;
    }
    if (character === ";" || character === "&" || character === "|") {
      let separator = character === "|" ? "pipe" : "other";
      if (command[index + 1] === character) {
        separator = "other";
        index += 1;
      } else if (character === "|" && command[index + 1] === "&") {
        index += 1;
      }
      endCommand(separator);
      index += 1;
      continue;
    }
    if (character === ">") {
      pushToken(tokens, token);
      token = "";
      tokens.push(command[index + 1] === ">" ? ">>" : ">");
      if (command[index + 1] === ">") index += 1;
      index += 1;
      continue;
    }
    if (character === "\\") {
      const next = command[index + 1];
      if (next !== undefined && /[(){}]/.test(next) && /^(?:[A-Za-z]:|\\\\)/.test(token)) {
        token += character;
        index += 1;
        continue;
      }
      if (next !== undefined && /[\s'"\\$`;&|>(){}>]/.test(next)) {
        token += next;
        index += 2;
        continue;
      }
      token += character;
      index += 1;
      continue;
    }
    token += character;
    index += 1;
  }
  if (quote !== null) throw new Error("unterminated shell quote");
  endCommand();
  return commands;
}

function commandAfter(tokens, switchNames, switchPattern = null) {
  for (let index = 1; index < tokens.length; index += 1) {
    const option = tokens[index].toLowerCase();
    if (switchNames.has(option) || switchPattern?.test(option)) {
      return tokens.slice(index + 1).join(" ");
    }
  }
  return null;
}

function parsedPowerShellSwitch(token) {
  const match = /^[-\/]([^:=\s]+)(?:(:|=)([\s\S]*))?$/.exec(token);
  if (match === null) return null;
  return { name: match[1].toLowerCase(), attached: match[2] === undefined ? null : match[3] };
}

function commandAfterPowerShell(tokens) {
  for (let index = 1; index < tokens.length; index += 1) {
    const option = parsedPowerShellSwitch(tokens[index]);
    if (option === null || option.name.length === 0 || !"command".startsWith(option.name)) continue;
    const remainder = tokens.slice(index + 1);
    if (option.attached !== null && option.attached !== "") remainder.unshift(option.attached);
    return remainder.join(" ");
  }
  return null;
}

function commandAfterCmd(tokens) {
  for (let index = 1; index < tokens.length; index += 1) {
    const match = /^\/(?:c|k)([\s\S]*)$/i.exec(tokens[index]);
    if (match === null) continue;
    const remainder = tokens.slice(index + 1);
    if (match[1] !== "") remainder.unshift(match[1]);
    return remainder.join(" ");
  }
  return null;
}

function wrapperCommandStart(tokens, executable) {
  const optionsWithValues = executable === "sudo"
    ? new Set(["-c", "--chdir", "-g", "--group", "-h", "--host", "-p", "--prompt", "-r", "--role", "-t", "--type", "-u", "--user"])
    : executable === "doas"
      ? new Set(["-u"])
      : executable === "exec"
        ? new Set(["-a"])
        : new Set();
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === "--") return index + 1;
    if (optionsWithValues.has(token.toLowerCase())) {
      index += 2;
      continue;
    }
    const hasAttachedValue = executable === "sudo"
      ? /^-(?:[cghprtuC]).+/i.test(token) || /^--(?:chdir|group|host|prompt|role|type|user)=/i.test(token)
      : executable === "doas"
        ? /^-u.+/i.test(token)
        : executable === "exec"
          ? /^-a.+/.test(token)
          : false;
    if (hasAttachedValue) {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      index += 1;
      continue;
    }
    return index;
  }
  return -1;
}

function envCommandStart(tokens) {
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === "--") return index + 1;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      index += 1;
      continue;
    }
    if (["-u", "--unset", "-C", "--chdir"].includes(token)) {
      index += 2;
      continue;
    }
    if (/^(?:-u.+|-C.+|--(?:unset|chdir)=.+)$/.test(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      index += 1;
      continue;
    }
    return index;
  }
  return -1;
}

function discardStandaloneGrouping(tokens) {
  let start = 0;
  let end = tokens.length;
  while (start < end && /^(?:\(|\{|begin)$/.test(tokens[start].toLowerCase())) start += 1;
  while (end > start && /^(?:\)|\}|end)$/.test(tokens[end - 1].toLowerCase())) end -= 1;
  const result = tokens.slice(start, end);
  while (result.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(result[0])) result.shift();
  return result;
}

function collectInvocations(command, invocations, depth = 0) {
  if (depth > MAX_NESTING) throw new Error("nested shell depth exceeds parser limit");
  for (const parsed of lexShell(command)) {
    const parsedTokens = parsed.tokens;
    const tokens = discardStandaloneGrouping(parsedTokens);
    if (tokens.length === 0) continue;
    if (invocations.length >= MAX_TOKENS) throw new Error("too many shell invocations");
    invocations.push({ tokens, receivesPipeline: parsed.receivesPipeline });
    const executable = executableName(tokens[0]);
    if (NESTED_SHELLS.has(executable)) {
      const nested = commandAfter(tokens, new Set(["-c", "--command"]), /^-[a-z]*c[a-z]*$/i);
      if (nested !== null && nested.trim() !== "") collectInvocations(nested, invocations, depth + 1);
    } else if (executable === "cmd") {
      const nested = commandAfterCmd(tokens);
      if (nested !== null && nested.trim() !== "") collectInvocations(nested, invocations, depth + 1);
    } else if (POWERSHELLS.has(executable)) {
      const nested = commandAfterPowerShell(tokens);
      if (nested !== null && nested.trim() !== "") collectInvocations(nested, invocations, depth + 1);
    } else if (WRAPPERS.has(executable)) {
      const start = wrapperCommandStart(tokens, executable);
      if (start > 0) collectInvocations(tokens.slice(start).join(" "), invocations, depth + 1);
    } else if (executable === "env") {
      const start = envCommandStart(tokens);
      if (start > 0) collectInvocations(tokens.slice(start).join(" "), invocations, depth + 1);
    }
  }
}

function hasEncodedPowerShell(tokens) {
  if (!POWERSHELLS.has(executableName(tokens[0]))) return false;
  return tokens.slice(1).some(token => {
    const option = parsedPowerShellSwitch(token);
    return option !== null && (
      option.name === "e" ||
      option.name === "ec" ||
      (option.name.length >= 2 && "encodedcommand".startsWith(option.name))
    );
  });
}

function isSystemDestructive(tokens) {
  const executable = executableName(tokens[0]);
  if (SYSTEM_COMMANDS.has(executable) || executable.startsWith("mkfs.")) return true;
  if (executable === "dd") {
    return tokens.slice(1).some(token => /^of=(?:\/dev\/|\\\\\.\\|\\\\\?\\)/i.test(token));
  }
  return false;
}

function gitSubcommand(tokens) {
  if (executableName(tokens[0]) !== "git") return null;
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === "-C" || token === "-c" || token === "--git-dir" || token === "--work-tree") {
      index += 2;
      continue;
    }
    if (token.startsWith("-")) {
      index += 1;
      continue;
    }
    return { name: token.toLowerCase(), args: tokens.slice(index + 1) };
  }
  return null;
}

function isGitDestructive(tokens) {
  const subcommand = gitSubcommand(tokens);
  if (subcommand === null) return false;
  const { name, args } = subcommand;
  if (name === "reset" && args.includes("--hard")) return true;
  if (name === "clean") {
    return args.some(argument => /^-[^-]*f/i.test(argument)) || args.includes("--force");
  }
  if (name === "push") {
    return args.some(argument =>
      (/^-[^-]/.test(argument) && argument.slice(1).includes("f")) ||
      argument.startsWith("+") ||
      /^--force(?:-with-lease|-if-includes)?(?:=|$)/i.test(argument)
    );
  }
  if (name === "restore") {
    return args.some(argument => !["-h", "--help"].includes(argument));
  }
  if (name === "checkout") {
    if (args.some(argument => argument === "-B" || /^-B.+/.test(argument))) return true;
    if (args.includes("--")) return true;
    if (args.some(argument => /^--pathspec-from-file(?:=|$)/.test(argument))) return true;
    if (args.some(argument =>
      argument === "--force" || (/^-[^-]/.test(argument) && argument.slice(1).includes("f"))
    )) return true;
    const valueOptions = new Set(["-b", "-B", "--conflict", "--orphan"]);
    const positionals = [];
    for (let index = 0; index < args.length; index += 1) {
      const argument = args[index];
      if (valueOptions.has(argument)) {
        index += 1;
      } else if (!argument.startsWith("-")) {
        positionals.push(argument);
      }
    }
    if (positionals.length > 1) return true;
    if (positionals.length === 1 && (
      positionals[0] === "." ||
      positionals[0] === ".." ||
      /^(?:[A-Za-z]:[\\/]|[\\/]|\.\.?[\\/])/.test(positionals[0]) ||
      /[\\/]/.test(positionals[0]) ||
      /\.[A-Za-z0-9_-]+$/.test(positionals[0])
    )) return true;
  }
  if (name === "branch") {
    return args.some(argument => argument === "-D" || argument === "--force");
  }
  if (name === "switch") {
    return args.some(argument =>
      argument === "--force" ||
      argument === "--discard-changes" ||
      (/^-[^-]/.test(argument) && argument.slice(1).includes("f"))
    );
  }
  return false;
}

function parsedPowerShellParameter(token) {
  const match = /^-([^:=\s]+)(?:(:|=)([\s\S]*))?$/.exec(token);
  if (match === null) return null;
  return { name: match[1].toLowerCase(), attached: match[2] === undefined ? null : match[3] };
}

function powerShellFileCandidates(tokens, executable) {
  const explicit = [];
  const positional = [];
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    const parameter = parsedPowerShellParameter(token);
    if (parameter === null) {
      positional.push(token);
      continue;
    }
    if (POWERSHELL_PATH_PARAMETERS.has(parameter.name)) {
      if (parameter.attached !== null && parameter.attached !== "") {
        explicit.push(parameter.attached);
      } else if (index + 1 < tokens.length) {
        explicit.push(tokens[index + 1]);
        index += 1;
      }
      continue;
    }
    if (POWERSHELL_VALUE_PARAMETERS.has(parameter.name) && parameter.attached === null) index += 1;
  }
  if (POWERSHELL_CONTENT_COMMANDS.has(executable)) {
    return explicit.length > 0 ? explicit : positional.slice(0, 1);
  }
  const positionalLimit = ["copy-item", "move-item", "rename-item"].includes(executable) ? 2 : positional.length;
  return [...explicit, ...positional.slice(0, positionalLimit)];
}

function fileCandidates(tokens) {
  const executable = executableName(tokens[0]);
  if (POWERSHELL_PATH_COMMANDS.has(executable)) {
    return powerShellFileCandidates(tokens, executable);
  }
  const candidates = [];
  if (FILE_MUTATORS.has(executable)) {
    let optionsEnded = false;
    for (let index = 1; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token === "--") {
        optionsEnded = true;
        continue;
      }
      const parameterValue = /^-(?:literalpath|path|destination|target):(.+)$/i.exec(token);
      if (parameterValue !== null) {
        candidates.push(parameterValue[1]);
        continue;
      }
      if (!optionsEnded && token.startsWith("-") && token !== "-") continue;
      if (!optionsEnded && ["del", "erase", "rd"].includes(executable) && CMD_SWITCHES.has(token.toLowerCase())) continue;
      candidates.push(token);
    }
  }
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (tokens[index] === ">" || tokens[index] === ">>") candidates.push(tokens[index + 1]);
  }
  return candidates;
}

function windowsAmbiguity(value) {
  if (value !== value.trim()) return true;
  const normalized = value.replaceAll("/", "\\");
  if (/^\\\\[?.]\\/.test(normalized)) return true;
  if (/^[A-Za-z]:(?!\\)/.test(normalized)) return true;
  const withoutDrive = normalized.replace(/^[A-Za-z]:/, "");
  if (withoutDrive.split("\\").some(segment => segment.includes(":"))) return true;
  const segments = normalized.split("\\").filter(Boolean);
  return segments.some(segment =>
    (segment !== "." && segment !== ".." && WINDOWS_RESERVED.test(segment)) ||
    (segment !== "." && segment !== ".." && /[. ]$/.test(segment)) ||
    /~\d+(?:\.|$)/i.test(segment)
  );
}

function dynamicTarget(value) {
  return /(?:\$\{|\$[A-Za-z0-9_(@*#?$!\-]|%[^%\r\n]+%|![^!\r\n]+!|^@[A-Za-z_(]|[*?`]|^~(?:[\\/]|$)|[{}])/u.test(value);
}

function windowsPath(value) {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
}

function comparable(pathApi, value) {
  const normalized = pathApi.normalize(value);
  return pathApi === win32 ? normalized.toLowerCase() : normalized;
}

function isOutside(pathApi, root, target) {
  const difference = pathApi.relative(root, target);
  return difference === ".." || difference.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(difference);
}

function isSensitivePath(value) {
  const segments = value.replaceAll("\\", "/").split("/").filter(Boolean);
  const lowered = segments.map(segment => segment.toLowerCase());
  if (lowered.some(segment => SENSITIVE_DIRECTORIES.has(segment))) return true;
  const name = lowered.at(-1) ?? "";
  return SENSITIVE_FILES.has(name) ||
    name.startsWith(".env.") ||
    /^credentials(?:\.|$)/.test(name) ||
    /\.(?:key|pem|p12|pfx)$/i.test(name) ||
    /(?:^|_)profile\.ps1$/i.test(name);
}

async function physicalRisk(pathApi, root, target) {
  const difference = pathApi.relative(root, target);
  let current = root;
  for (const part of difference.split(/[\\/]+/).filter(Boolean)) {
    current = pathApi.join(current, part);
    let information;
    try {
      information = await lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      return "sensitive";
    }
    if (information.isSymbolicLink()) {
      try {
        const canonical = await realpath(current);
        return isOutside(pathApi, root, canonical) ? "outside" : "sensitive";
      } catch {
        return "sensitive";
      }
    }
    try {
      const canonical = await realpath(current);
      if (comparable(pathApi, canonical) !== comparable(pathApi, current)) {
        return isOutside(pathApi, root, canonical) ? "outside" : "sensitive";
      }
    } catch {
      return "sensitive";
    }
    if (comparable(pathApi, current) === comparable(pathApi, target) && information.isFile() && information.nlink > 1) {
      return "sensitive";
    }
  }
  return null;
}

async function analyzeTarget(value, workspaceRoot, { patch = false } = {}) {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) {
    return patch ? "patch-outside-workspace" : "dynamic-target";
  }
  if (windowsAmbiguity(value)) {
    return patch ? "patch-outside-workspace" : "dynamic-target";
  }
  let targetText = value.trim();
  if (
    targetText.length >= 2 &&
    ((targetText.startsWith('"') && targetText.endsWith('"')) ||
      (targetText.startsWith("'") && targetText.endsWith("'")))
  ) {
    targetText = targetText.slice(1, -1);
  }
  const rootUsesWindows = windowsPath(workspaceRoot);
  const pathApi = rootUsesWindows ? win32 : posix;
  const root = pathApi.resolve(workspaceRoot);
  const driveRoot = /^[A-Za-z]:[\\/]?$/.test(targetText);
  if (driveRoot || targetText === "/" || targetText === "\\") {
    return patch ? "patch-outside-workspace" : "protected-root";
  }
  if (windowsPath(targetText) && !rootUsesWindows) {
    return patch ? "patch-outside-workspace" : "protected-root";
  }
  if (!rootUsesWindows && targetText.startsWith("\\")) {
    return patch ? "patch-outside-workspace" : "dynamic-target";
  }
  if (rootUsesWindows && targetText.startsWith("/") && !/^[A-Za-z]:/.test(targetText)) {
    return patch ? "patch-outside-workspace" : "protected-root";
  }

  const resolvedTarget = pathApi.resolve(root, targetText);
  const normalizedRoot = comparable(pathApi, root);
  const normalizedTarget = comparable(pathApi, resolvedTarget);
  if (normalizedTarget === normalizedRoot || isOutside(pathApi, root, resolvedTarget)) {
    return patch ? "patch-outside-workspace" : "protected-root";
  }
  const home = homedir();
  if (windowsPath(home) === rootUsesWindows) {
    const normalizedHome = comparable(pathApi, pathApi.resolve(home));
    if (normalizedTarget === normalizedHome) return patch ? "patch-outside-workspace" : "protected-root";
  }
  if (isSensitivePath(targetText) || isSensitivePath(pathApi.relative(root, resolvedTarget))) {
    return patch ? "patch-sensitive-path" : "sensitive-path";
  }
  if (dynamicTarget(targetText)) {
    return patch ? "patch-outside-workspace" : "dynamic-target";
  }
  const physical = await physicalRisk(pathApi, root, resolvedTarget);
  if (physical === "outside") return patch ? "patch-outside-workspace" : "protected-root";
  if (physical === "sensitive") return patch ? "patch-sensitive-path" : "sensitive-path";
  return null;
}

async function classifyShell(command, workspaceRoot) {
  const invocations = [];
  try {
    collectInvocations(command, invocations);
  } catch {
    return "malformed-input";
  }
  const rules = [];
  for (const invocation of invocations) {
    const { tokens, receivesPipeline } = invocation;
    if (hasEncodedPowerShell(tokens)) rules.push("encoded-command");
    if (isSystemDestructive(tokens)) rules.push("system-destructive");
    if (isGitDestructive(tokens)) rules.push("git-destructive");
    const candidates = fileCandidates(tokens);
    if (receivesPipeline && FILE_MUTATORS.has(executableName(tokens[0])) && candidates.length === 0) {
      rules.push("dynamic-target");
    }
    for (const candidate of candidates) {
      const risk = await analyzeTarget(candidate, workspaceRoot);
      if (risk !== null) rules.push(risk);
    }
  }
  return chooseRule(rules);
}

function parsePatch(command) {
  if (Buffer.byteLength(command, "utf8") > MAX_COMMAND_BYTES || command.includes("\0")) return null;
  const lines = command.replaceAll("\r\n", "\n").split("\n");
  while (lines.at(-1) === "") lines.pop();
  if (lines[0] !== "*** Begin Patch" || lines.at(-1) !== "*** End Patch") return null;
  const targets = [];
  let primaryCount = 0;
  let mayMove = false;
  for (let index = 1; index < lines.length - 1; index += 1) {
    const line = lines[index];
    const primary = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (primary !== null) {
      if (primary[2].trim() === "") return null;
      targets.push(primary[2]);
      primaryCount += 1;
      mayMove = primary[1] === "Update";
      continue;
    }
    const move = /^\*\*\* Move to: (.+)$/.exec(line);
    if (move !== null) {
      if (!mayMove || move[1].trim() === "") return null;
      targets.push(move[1]);
      mayMove = false;
      continue;
    }
    if (line.startsWith("*** ")) return null;
  }
  return primaryCount > 0 ? targets : null;
}

async function classifyPatch(command, workspaceRoot) {
  const targets = parsePatch(command);
  if (targets === null) return "malformed-input";
  const rules = [];
  for (const target of targets) {
    const risk = await analyzeTarget(target, workspaceRoot, { patch: true });
    if (risk !== null) rules.push(risk);
  }
  return chooseRule(rules);
}

export async function classifyPreToolUse(event, { workspaceRoot, active = true } = {}) {
  if (!active) return { denied: false, ruleId: "no-match", supported: false };
  if (!plainObject(event) || !SUPPORTED_TOOLS.has(event.tool_name)) {
    return { denied: false, ruleId: "no-match", supported: false };
  }
  if (
    !plainObject(event.tool_input) ||
    !Object.hasOwn(event.tool_input, "command") ||
    typeof event.tool_input.command !== "string" ||
    event.tool_input.command.trim() === ""
  ) {
    return { denied: true, ruleId: "malformed-input", supported: true };
  }
  const ruleId = event.tool_name === "Bash"
    ? await classifyShell(event.tool_input.command, workspaceRoot)
    : await classifyPatch(event.tool_input.command, workspaceRoot);
  return { denied: ruleId !== "no-match", ruleId, supported: true };
}

export async function inspectPreToolUse(event, options = {}) {
  const result = await classifyPreToolUse(event, options);
  return result.denied ? deny(result.ruleId) : {};
}
