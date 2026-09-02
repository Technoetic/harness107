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
  "new-item",
  "out-file",
  "rd",
  "ren",
  "rename",
  "remove-item",
  "rename-item",
  "ri",
  "rm",
  "rmdir",
  "set-acl",
  "set-content",
  "takeown",
  "tee-object",
  "truncate",
  "unlink"
]);
const NESTED_SHELLS = new Set(["bash", "dash", "sh", "zsh"]);
const POWERSHELLS = new Set(["powershell", "pwsh"]);
const WRAPPERS = new Set(["builtin", "call", "command", "doas", "exec", "nice", "nohup", "sudo", "time"]);
const POWERSHELL_ALIASES = new Map([
  ["ac", "add-content"],
  ["clc", "clear-content"],
  ["cpi", "copy-item"],
  ["mi", "move-item"],
  ["ni", "new-item"],
  ["rni", "rename-item"],
  ["sc", "set-content"],
  ["tee", "tee-object"]
]);
const CMD_SWITCHES = new Set(["/a", "/d", "/f", "/i", "/n", "/q", "/s"]);
const CMD_FILE_SWITCHES = new Map([
  ["copy", new Set(["/?", "/a", "/b", "/d", "/j", "/l", "/n", "/v", "/y", "/-y", "/z"])],
  ["move", new Set(["/?", "/y", "/-y"])],
  ["ren", new Set(["/?"])],
  ["rename", new Set(["/?"])]
]);
const POWERSHELL_PATH_COMMANDS = new Set([
  "add-content",
  "clear-content",
  "copy-item",
  "move-item",
  "new-item",
  "out-file",
  "remove-item",
  "rename-item",
  "ri",
  "set-content",
  "tee-object"
]);
const POWERSHELL_CONTENT_COMMANDS = new Set([
  "add-content",
  "clear-content",
  "out-file",
  "set-content",
  "tee-object"
]);
const PIPELINE_SOURCE_MUTATORS = new Set([
  "move-item",
  "remove-item",
  "rename-item",
  "ri"
]);
const PIPELINE_DATA_SINKS = new Set([
  "add-content",
  "out-file",
  "set-content",
  "tee-object"
]);
const POWERSHELL_PATH_PARAMETERS = new Set([
  "destination",
  "filepath",
  "literalpath",
  "name",
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
  "fromsession",
  "include",
  "informationaction",
  "informationvariable",
  "inputobject",
  "itemtype",
  "outbuffer",
  "outvariable",
  "pipelinevariable",
  "stream",
  "tosession",
  "type",
  "value",
  "variable",
  "warningaction",
  "warningvariable",
  "width"
]);
const POWERSHELL_SWITCH_PARAMETERS = new Set([
  "append",
  "confirm",
  "container",
  "debug",
  "force",
  "noclobber",
  "nonewline",
  "passthru",
  "recurse",
  "usetransaction",
  "verbose",
  "whatif"
]);
const POWERSHELL_COMMON_PARAMETERS = [
  "debug",
  "erroraction",
  "errorvariable",
  "informationaction",
  "informationvariable",
  "outbuffer",
  "outvariable",
  "pipelinevariable",
  "verbose",
  "warningaction",
  "warningvariable"
];
const POWERSHELL_COMMON_ALIASES = new Map([
  ["cf", "confirm"],
  ["db", "debug"],
  ["ea", "erroraction"],
  ["ev", "errorvariable"],
  ["infa", "informationaction"],
  ["iv", "informationvariable"],
  ["ob", "outbuffer"],
  ["ov", "outvariable"],
  ["pv", "pipelinevariable"],
  ["vb", "verbose"],
  ["wa", "warningaction"],
  ["wi", "whatif"],
  ["wv", "warningvariable"]
]);
function powerShellParameterSet(...specific) {
  return new Set([...POWERSHELL_COMMON_PARAMETERS, ...specific]);
}
const POWERSHELL_COMMAND_PARAMETERS = new Map([
  ["add-content", powerShellParameterSet("confirm", "credential", "encoding", "exclude", "filter", "force", "include", "literalpath", "nonewline", "passthru", "path", "stream", "usetransaction", "value", "whatif")],
  ["clear-content", powerShellParameterSet("confirm", "credential", "exclude", "filter", "force", "include", "literalpath", "path", "stream", "usetransaction", "whatif")],
  ["copy-item", powerShellParameterSet("confirm", "container", "credential", "destination", "exclude", "filter", "force", "fromsession", "include", "literalpath", "passthru", "path", "recurse", "tosession", "usetransaction", "whatif")],
  ["move-item", powerShellParameterSet("confirm", "credential", "destination", "exclude", "filter", "force", "include", "literalpath", "passthru", "path", "usetransaction", "whatif")],
  ["new-item", powerShellParameterSet("confirm", "credential", "force", "itemtype", "name", "path", "usetransaction", "value", "whatif")],
  ["out-file", powerShellParameterSet("append", "confirm", "encoding", "filepath", "force", "inputobject", "literalpath", "noclobber", "nonewline", "whatif", "width")],
  ["remove-item", powerShellParameterSet("confirm", "credential", "exclude", "filter", "force", "include", "literalpath", "path", "recurse", "stream", "usetransaction", "whatif")],
  ["rename-item", powerShellParameterSet("confirm", "credential", "force", "informationaction", "informationvariable", "literalpath", "newname", "passthru", "path", "usetransaction", "whatif")],
  ["ri", powerShellParameterSet("confirm", "credential", "exclude", "filter", "force", "include", "literalpath", "path", "recurse", "stream", "usetransaction", "whatif")],
  ["set-content", powerShellParameterSet("confirm", "credential", "encoding", "exclude", "filter", "force", "include", "literalpath", "nonewline", "passthru", "path", "stream", "usetransaction", "value", "whatif")],
  ["tee-object", powerShellParameterSet("append", "filepath", "inputobject", "literalpath", "variable")]
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
const CONVENTIONAL_EXTENSIONLESS_FILES = new Set([
  "authors",
  "changelog",
  "copying",
  "dockerfile",
  "jenkinsfile",
  "license",
  "makefile",
  "notice",
  "procfile",
  "readme",
  "vagrantfile"
]);

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
  ...POWERSHELL_ALIASES.keys(),
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

function fileMutationName(value) {
  const executable = executableName(value);
  const unwrapped = value.replace(/^[({]+|[)}]+$/g, "");
  const leaf = unwrapped.split(/[\\/]/).at(-1);
  if (/\.(?:exe|com)$/i.test(leaf)) return executable;
  return POWERSHELL_ALIASES.get(executable) ?? executable;
}

function pushToken(tokens, dynamicTokens, token, dynamic) {
  if (token !== "") {
    tokens.push(token);
    dynamicTokens.push(dynamic);
  }
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

function backtickEnd(command, start) {
  for (let index = start + 1; index < command.length; index += 1) {
    if (command[index] === "\\") {
      index += 1;
      continue;
    }
    if (command[index] === "`") return index + 1;
  }
  return null;
}

const ANSI_C_ESCAPES = new Map([
  ["a", "\u0007"],
  ["b", "\b"],
  ["e", "\u001b"],
  ["E", "\u001b"],
  ["f", "\f"],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
  ["v", "\u000b"],
  ["\\", "\\"],
  ["'", "'"],
  ['"', '"']
]);

function ansiCQuote(command, start) {
  let value = "";
  let index = start + 2;
  while (index < command.length) {
    const character = command[index];
    if (character === "'") return { end: index + 1, value };
    if (character !== "\\") {
      value += character;
      index += 1;
      continue;
    }
    const escaped = command[index + 1];
    if (escaped === undefined) throw new Error("unterminated ANSI-C quote");
    if (ANSI_C_ESCAPES.has(escaped)) {
      value += ANSI_C_ESCAPES.get(escaped);
      index += 2;
      continue;
    }
    const remainder = command.slice(index + 1);
    const numeric = /^(?:x([0-9a-fA-F]{1,2})|u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8})|([0-7]{1,3}))/.exec(remainder);
    if (numeric !== null) {
      const digits = numeric.slice(1).find(part => part !== undefined);
      const radix = numeric[4] === undefined ? 16 : 8;
      const codePoint = Number.parseInt(digits, radix);
      if (!Number.isSafeInteger(codePoint) || codePoint > 0x10ffff) {
        throw new Error("invalid ANSI-C escape");
      }
      value += String.fromCodePoint(codePoint);
      index += numeric[0].length + 1;
      continue;
    }
    throw new Error("unsupported ANSI-C escape");
  }
  throw new Error("unterminated ANSI-C quote");
}

function hasDynamicShellSyntax(command, index, token, quote) {
  const character = command[index];
  const next = command[index + 1] ?? "";
  if (character === "$") return /[({A-Za-z0-9_@*#?$!\-]/.test(next);
  if (character === "%") return command.indexOf("%", index + 1) > index + 1;
  if (character === "!") return command.indexOf("!", index + 1) > index + 1;
  if (quote !== null) return false;
  if (character === "*" || character === "?" || character === "[") return true;
  if (character === "{") {
    return token !== "" || /^\{[^{}]*,[^{}]*\}/.test(command.slice(index));
  }
  if (character === "@") return token === "" && /[A-Za-z_(]/.test(next);
  return character === "~" && token === "";
}

function simplePowerShellLiteral(value) {
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    const inner = value.slice(1, -1);
    return /[$`]/.test(inner) ? null : inner.replaceAll('""', '"');
  }
  return /^[A-Za-z0-9._:\\/+,-]+$/.test(value) ? value : null;
}

function joinedPowerShellLiteral(parent, child) {
  const separator = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
  const left = parent.replace(/[\\/]+$/, "");
  const right = child.replace(/^[\\/]+/, "");
  if (left === "") return `${separator}${right}`;
  return `${left}${separator}${right}`;
}

function collapsePowerShellExpressions(command) {
  const atom = String.raw`(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s()]+)`;
  const joinPath = new RegExp(String.raw`\(\s*join-path\s+(${atom})\s+(${atom})\s*\)`, "gi");
  let collapsed = command.replace(joinPath, (whole, parentValue, childValue) => {
    const parent = simplePowerShellLiteral(parentValue);
    const child = simplePowerShellLiteral(childValue);
    return parent === null || child === null ? whole : quoteShellLiteral(joinedPowerShellLiteral(parent, child));
  });
  collapsed = collapsed.replace(/\(\s*('(?:[^']|'')*'|"[^"$`]*")\s*\)/g, (whole, value) => {
    const literal = simplePowerShellLiteral(value);
    return literal === null ? whole : quoteShellLiteral(literal);
  });
  return collapsed;
}

function lexShell(command) {
  if (Buffer.byteLength(command, "utf8") > MAX_COMMAND_BYTES || command.includes("\0")) {
    throw new Error("shell input is outside the bounded parser contract");
  }
  const commands = [];
  let tokens = [];
  let dynamicTokens = [];
  let token = "";
  let tokenDynamic = false;
  let quote = null;
  let index = 0;
  let receivesPipeline = false;
  let substitutions = [];
  const endCommand = separator => {
    pushToken(tokens, dynamicTokens, token, tokenDynamic);
    token = "";
    tokenDynamic = false;
    const hadTokens = tokens.length > 0;
    if (hadTokens || substitutions.length > 0) {
      commands.push({
        tokens,
        dynamicTokens,
        receivesPipeline,
        sendsPipeline: separator === "pipe",
        substitutions
      });
    }
    tokens = [];
    dynamicTokens = [];
    substitutions = [];
    if (separator !== undefined && (hadTokens || separator === "pipe")) {
      receivesPipeline = separator === "pipe";
    }
  };

  while (index < command.length) {
    const character = command[index];
    if (quote === null && character === "$" && command[index + 1] === "'") {
      const parsed = ansiCQuote(command, index);
      token += parsed.value;
      index = parsed.end;
      continue;
    }
    if (quote !== "'" && character === "$" && command[index + 1] === "(") {
      const end = substitutionEnd(command, index);
      substitutions.push(command.slice(index + 2, end - 1));
      token += command.slice(index, end);
      tokenDynamic = true;
      index = end;
      continue;
    }
    if (quote !== "'" && character === "`") {
      const end = backtickEnd(command, index);
      if (end !== null) {
        substitutions.push(command.slice(index + 1, end - 1));
        token += command.slice(index, end);
        tokenDynamic = true;
        index = end;
        continue;
      }
    }
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
        if (hasDynamicShellSyntax(command, index, token, quote)) tokenDynamic = true;
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
    if (character === "#" && token === "" && tokens.length > 0) {
      while (index < command.length && command[index] !== "\n") index += 1;
      continue;
    }
    if (/\s/.test(character)) {
      pushToken(tokens, dynamicTokens, token, tokenDynamic);
      token = "";
      tokenDynamic = false;
      if (character === "\n" || character === "\r") endCommand("other");
      index += 1;
      continue;
    }
    if (character === "(" || character === ")") {
      endCommand("other");
      index += 1;
      continue;
    }
    if (
      token === "" &&
      (character === "}" || (character === "{" && /\s/.test(command[index + 1] ?? "")))
    ) {
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
      pushToken(tokens, dynamicTokens, token, tokenDynamic);
      token = "";
      tokenDynamic = false;
      tokens.push(command[index + 1] === ">" ? ">>" : command[index + 1] === "&" ? ">&" : ">");
      dynamicTokens.push(false);
      if ([">", "&", "|"].includes(command[index + 1])) index += 1;
      index += 1;
      continue;
    }
    if (hasDynamicShellSyntax(command, index, token, quote)) tokenDynamic = true;
    if (character === "\\") {
      const next = command[index + 1];
      if (next !== undefined && /[(){}]/.test(next) && /^(?:[A-Za-z]:|\\\\)/.test(token)) {
        token += character;
        index += 1;
        continue;
      }
      if (next !== undefined && /[\s'"\\/$`;&|>(){}>]/.test(next)) {
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

function commandAfterPowerShell(tokens, dynamicTokens) {
  for (let index = 1; index < tokens.length; index += 1) {
    const option = parsedPowerShellSwitch(tokens[index]);
    if (option === null || option.name.length === 0 || !"command".startsWith(option.name)) continue;
    const remainder = tokens.slice(index + 1);
    if (option.attached !== null && option.attached !== "") remainder.unshift(option.attached);
    return {
      command: remainder.join(" "),
      dynamic: dynamicTokens.slice(index).some(Boolean)
    };
  }
  return null;
}

function commandAfterCmd(tokens) {
  for (let index = 1; index < tokens.length; index += 1) {
    const match = /^(?:\/(?:[adqsu]|[efv]:[^/\s]*))*\/(?:c|k)([\s\S]*)$/i.exec(tokens[index]);
    if (match === null) continue;
    const remainder = tokens.slice(index + 1);
    if (match[1] !== "") remainder.unshift(match[1]);
    return remainder.join(" ").replace(/^@+/, "");
  }
  return null;
}

function parsedLongOption(token) {
  const match = /^--([^=]+)(?:=([\s\S]*))?$/.exec(token);
  if (match === null) return null;
  const negated = match[1].startsWith("no-");
  return {
    attached: match[2] === undefined ? null : match[2],
    name: negated ? match[1].slice(3) : match[1],
    negated
  };
}

function resolvedLongOption(token, available) {
  const parsed = parsedLongOption(token);
  if (parsed === null) return null;
  const exact = available.find(name => name === parsed.name);
  if (exact !== undefined) return { ...parsed, name: exact };
  const matches = available.filter(name => name.startsWith(parsed.name));
  return matches.length === 1 ? { ...parsed, name: matches[0] } : null;
}

function couldResolveLongOption(token, available, expected) {
  const parsed = parsedLongOption(token);
  return parsed !== null && !parsed.negated && available.some(name => name === expected && name.startsWith(parsed.name));
}

function timeValueOption(token) {
  const match = /^-[apqv]*([fo])([\s\S]*)$/.exec(token);
  if (match === null) return null;
  return {
    attached: match[2] === "" ? null : match[2],
    name: match[1] === "o" ? "output" : "format"
  };
}

function wrapperCommandStart(tokens, executable) {
  const optionsWithValues = executable === "sudo"
    ? new Set(["-c", "--chdir", "-D", "-g", "--group", "-h", "--host", "-p", "--prompt", "-r", "--role", "-t", "--type", "-u", "--user"])
    : executable === "doas"
      ? new Set(["-u"])
      : executable === "exec"
        ? new Set(["-a"])
        : executable === "nice"
          ? new Set(["-n", "--adjustment"])
          : executable === "time"
            ? new Set(["-f", "--format", "-o", "--output"])
            : new Set();
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === "--") return index + 1;
    if (["--help", "--version"].includes(token)) return -1;
    const timeOption = executable === "time" ? timeValueOption(token) : null;
    if (timeOption !== null) {
      index += timeOption.attached === null ? 2 : 1;
      continue;
    }
    const longOption = resolvedLongOption(
      token,
      executable === "nice"
        ? ["adjustment", "help", "version"]
        : executable === "time"
          ? ["format", "help", "output", "version"]
          : []
    );
    if (longOption !== null && !longOption.negated) {
      if (["help", "version"].includes(longOption.name)) return -1;
      index += longOption.attached === null ? 2 : 1;
      continue;
    }
    if (optionsWithValues.has(token) || optionsWithValues.has(token.toLowerCase())) {
      index += 2;
      continue;
    }
    const hasAttachedValue = executable === "sudo"
      ? /^-(?:[cghprtuCD]).+/i.test(token) || /^--(?:chdir|group|host|prompt|role|type|user)=/i.test(token)
      : executable === "doas"
        ? /^-u.+/i.test(token)
        : executable === "exec"
          ? /^-a.+/.test(token)
          : executable === "nice"
            ? /^-n.+/.test(token) || /^--adjustment=/.test(token)
            : executable === "time"
              ? /^--(?:format|output)=/.test(token)
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

function parsedEnvShortOption(token) {
  if (!/^-[^-]/.test(token)) return null;
  for (let index = 1; index < token.length; index += 1) {
    const name = token[index];
    if (["0", "i", "v"].includes(name)) continue;
    const canonical = new Map([
      ["a", "argv0"],
      ["C", "chdir"],
      ["S", "split-string"],
      ["u", "unset"]
    ]).get(name);
    if (canonical === undefined) return null;
    return {
      attached: index + 1 < token.length ? token.slice(index + 1) : null,
      name: canonical,
      negated: false
    };
  }
  return { attached: "", name: "flag", negated: false };
}

function envCommandParts(tokens, dynamicTokens) {
  let expandedTokens = [...tokens];
  let expandedDynamics = [...dynamicTokens];
  for (let splitCount = 0; splitCount <= MAX_NESTING; splitCount += 1) {
    let index = 1;
    let expanded = false;
    while (index < expandedTokens.length) {
      const token = expandedTokens[index];
      if (["--help", "--version"].includes(token)) return null;
      if (token === "--") {
        return {
          tokens: expandedTokens.slice(index + 1),
          dynamicTokens: expandedDynamics.slice(index + 1)
        };
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
        index += 1;
        continue;
      }
      const option = resolvedLongOption(token, ["argv0", "chdir", "split-string", "unset"]) ??
        parsedEnvShortOption(token);
      if (option !== null && !option.negated && option.name === "split-string") {
        const splitValue = option.attached ?? expandedTokens[index + 1];
        const consumed = option.attached === null ? 2 : 1;
        if (typeof splitValue !== "string" || splitValue === "") return null;
        const parsed = lexShell(splitValue);
        if (parsed.length !== 1 || parsed[0].substitutions.length > 0) return null;
        expandedTokens = [
          expandedTokens[0],
          ...expandedTokens.slice(1, index),
          ...parsed[0].tokens,
          ...expandedTokens.slice(index + consumed)
        ];
        expandedDynamics = [
          expandedDynamics[0],
          ...expandedDynamics.slice(1, index),
          ...parsed[0].dynamicTokens,
          ...expandedDynamics.slice(index + consumed)
        ];
        expanded = true;
        break;
      }
      if (option !== null && !option.negated) {
        index += option.name === "flag" || option.attached !== null ? 1 : 2;
        continue;
      }
      if (token.startsWith("-")) {
        index += 1;
        continue;
      }
      return {
        tokens: expandedTokens.slice(index),
        dynamicTokens: expandedDynamics.slice(index)
      };
    }
    if (!expanded) return null;
  }
  throw new Error("nested env split-string exceeds parser limit");
}

function staticAssignments(parsed) {
  if (
    parsed.tokens.length === 0 ||
    parsed.substitutions.length > 0 ||
    parsed.receivesPipeline ||
    parsed.sendsPipeline
  ) return null;
  const assignments = [];
  for (let index = 0; index < parsed.tokens.length; index += 1) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=([^\s]*)$/.exec(parsed.tokens[index]);
    if (match === null || parsed.dynamicTokens[index]) return null;
    assignments.push([match[1], match[2]]);
  }
  return assignments;
}

function staticSubstitutionValue(value) {
  const match = /^(?:\$\(([\s\S]*)\)|`([\s\S]*)`)$/.exec(value);
  if (match === null) return null;
  const parsed = lexShell(match[1] ?? match[2]);
  if (
    parsed.length !== 1 ||
    parsed[0].substitutions.length > 0 ||
    parsed[0].dynamicTokens.some(Boolean) ||
    executableName(parsed[0].tokens[0] ?? "") !== "printf"
  ) return null;
  if (parsed[0].tokens.length === 2 && !parsed[0].tokens[1].includes("%")) {
    return parsed[0].tokens[1];
  }
  if (parsed[0].tokens.length === 3 && parsed[0].tokens[1] === "%s") {
    return parsed[0].tokens[2];
  }
  return null;
}

function expandBraceWord(value) {
  const match = /^(.*?)\{([^{}]*,[^{}]*)\}(.*)$/.exec(value);
  if (match === null) return [value];
  const results = [];
  for (const item of match[2].split(",")) {
    for (const expanded of expandBraceWord(`${match[1]}${item}${match[3]}`)) {
      results.push(expanded);
      if (results.length > MAX_TOKENS) throw new Error("brace expansion exceeds parser limit");
    }
  }
  return results;
}

function expandStaticTokens(tokens, dynamicTokens, variables) {
  const expandedTokens = [];
  const expandedDynamics = [];
  for (let index = 0; index < tokens.length; index += 1) {
    let value = tokens[index];
    let dynamic = dynamicTokens[index];
    const variable = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/.exec(value);
    if (dynamic && variable !== null) {
      const resolved = variables.get(variable[1] ?? variable[2]);
      if (resolved !== undefined) {
        value = resolved;
        dynamic = false;
      }
    }
    if (dynamic && index === 0) {
      const resolved = staticSubstitutionValue(value);
      if (resolved !== null) {
        value = resolved;
        dynamic = false;
      }
    }
    const braceValues = dynamic ? expandBraceWord(value) : [value];
    for (const braceValue of braceValues) {
      expandedTokens.push(braceValue);
      expandedDynamics.push(
        braceValue === value ? dynamic : index === 0 ? dynamicTarget(braceValue) : dynamic
      );
      if (expandedTokens.length > MAX_TOKENS) throw new Error("expanded tokens exceed parser limit");
    }
  }
  return { tokens: expandedTokens, dynamicTokens: expandedDynamics };
}

function discardStandaloneGrouping(tokens, dynamicTokens) {
  let start = 0;
  let end = tokens.length;
  while (start < end && /^(?:\(|\{|begin)$/.test(tokens[start].toLowerCase())) start += 1;
  while (end > start && /^(?:\)|\}|end)$/.test(tokens[end - 1].toLowerCase())) end -= 1;
  const result = {
    tokens: tokens.slice(start, end),
    dynamicTokens: dynamicTokens.slice(start, end)
  };
  while (result.tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(result.tokens[0])) {
    result.tokens.shift();
    result.dynamicTokens.shift();
  }
  return result;
}

function collectParsedInvocation(parsed, invocations, depth, variables = new Map()) {
  if (depth > MAX_NESTING) throw new Error("nested shell depth exceeds parser limit");
  for (const substitution of parsed.substitutions) {
    collectInvocations(substitution, invocations, depth + 1);
  }
  const expanded = expandStaticTokens(parsed.tokens, parsed.dynamicTokens, variables);
  const filtered = discardStandaloneGrouping(expanded.tokens, expanded.dynamicTokens);
  const { tokens, dynamicTokens } = filtered;
  if (tokens.length === 0) return;
  if (invocations.length >= MAX_TOKENS) throw new Error("too many shell invocations");
  const invocation = {
    tokens,
    dynamicTokens,
    receivesPipeline: parsed.receivesPipeline,
    sendsPipeline: parsed.sendsPipeline ?? false,
    dynamicCommand: dynamicTokens[0] ?? false
  };
  invocations.push(invocation);
  const executable = executableName(tokens[0]);
  if (NESTED_SHELLS.has(executable)) {
    const nested = commandAfter(tokens, new Set(["-c", "--command"]), /^-[a-z]*c[a-z]*$/i);
    if (nested !== null && nested.trim() !== "") collectInvocations(nested, invocations, depth + 1);
  } else if (executable === "cmd") {
    const nested = commandAfterCmd(tokens);
    if (nested !== null && nested.trim() !== "") collectInvocations(nested, invocations, depth + 1);
  } else if (POWERSHELLS.has(executable)) {
    const nested = commandAfterPowerShell(tokens, dynamicTokens);
    if (nested !== null && nested.command.trim() !== "") {
      invocation.dynamicCommand ||= nested.dynamic;
      collectInvocations(nested.command, invocations, depth + 1);
    }
  } else if (executable === "git") {
    const nested = gitAliasCommand(tokens);
    if (nested !== null) collectInvocations(nested, invocations, depth + 1);
  } else {
    const parts = executable === "env" ? envCommandParts(tokens, dynamicTokens) : null;
    const start = WRAPPERS.has(executable) ? wrapperCommandStart(tokens, executable) : -1;
    if (parts !== null || start > 0) {
      collectParsedInvocation({
        tokens: parts?.tokens ?? tokens.slice(start),
        dynamicTokens: parts?.dynamicTokens ?? dynamicTokens.slice(start),
        receivesPipeline: parsed.receivesPipeline,
        sendsPipeline: parsed.sendsPipeline,
        substitutions: []
      }, invocations, depth + 1, variables);
    }
  }
}

function collectInvocations(command, invocations, depth = 0) {
  if (depth > MAX_NESTING) throw new Error("nested shell depth exceeds parser limit");
  const variables = new Map();
  for (const parsed of lexShell(collapsePowerShellExpressions(command))) {
    const assignments = staticAssignments(parsed);
    if (assignments !== null) {
      for (const [name, value] of assignments) variables.set(name, value);
      continue;
    }
    collectParsedInvocation(parsed, invocations, depth, variables);
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

const GUARDED_GIT_BUILTINS = new Set([
  "branch",
  "checkout",
  "clean",
  "help",
  "push",
  "reset",
  "restore",
  "status",
  "switch",
  "version"
]);
const GIT_GLOBAL_VALUE_OPTIONS = ["config-env", "git-dir", "namespace", "work-tree"];
const GIT_SUBCOMMAND_LONG_OPTIONS = new Map([
  ["branch", ["abbrev", "all", "color", "column", "contains", "copy", "create-reflog", "delete", "edit-description", "force", "format", "ignore-case", "list", "merged", "move", "omit-empty", "points-at", "recurse-submodules", "remotes", "set-upstream-to", "show-current", "sort", "track", "unset-upstream", "verbose"]],
  ["checkout", ["auto-advance", "conflict", "detach", "force", "guess", "ignore-other-worktrees", "ignore-skip-worktree-bits", "inter-hunk-context", "merge", "orphan", "ours", "overlay", "overwrite-ignore", "patch", "pathspec-file-nul", "pathspec-from-file", "progress", "quiet", "recurse-submodules", "theirs", "track", "unified"]],
  ["clean", ["dry-run", "exclude", "force", "interactive", "quiet"]],
  ["push", ["all", "atomic", "branches", "delete", "dry-run", "exec", "follow-tags", "force", "force-if-includes", "force-with-lease", "mirror", "porcelain", "progress", "prune", "push-option", "receive-pack", "recurse-submodules", "repo", "set-upstream", "signed", "tags", "thin", "verify"]],
  ["switch", ["conflict", "create", "detach", "discard-changes", "force", "force-create", "guess", "ignore-other-worktrees", "merge", "orphan", "overwrite-ignore", "progress", "quiet", "recurse-submodules", "track"]]
]);

function recordGitConfig(value, aliases) {
  const match = /^alias\.([^=]+)=([\s\S]*)$/i.exec(value);
  if (match !== null && match[1] !== "") aliases.set(match[1].toLowerCase(), match[2]);
}

function gitSubcommand(tokens) {
  if (executableName(tokens[0]) !== "git") return null;
  const aliases = new Map();
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index];
    if (["-h", "--help", "-v", "--version"].includes(token)) {
      return { inert: true, aliases, name: null, args: [] };
    }
    if (token === "-c") {
      if (index + 1 < tokens.length) recordGitConfig(tokens[index + 1], aliases);
      index += 2;
      continue;
    }
    const attachedConfig = /^-c([\s\S]+)$/.exec(token);
    if (attachedConfig !== null) {
      recordGitConfig(attachedConfig[1], aliases);
      index += 1;
      continue;
    }
    const globalValue = resolvedLongOption(token, GIT_GLOBAL_VALUE_OPTIONS);
    if (globalValue !== null && !globalValue.negated) {
      index += globalValue.attached === null ? 2 : 1;
      continue;
    }
    if (token === "-C" || token === "--git-dir" || token === "--work-tree") {
      index += 2;
      continue;
    }
    if (token.startsWith("-")) {
      index += 1;
      continue;
    }
    return { inert: false, aliases, name: token.toLowerCase(), args: tokens.slice(index + 1) };
  }
  return null;
}

function quoteShellLiteral(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function gitAliasCommand(tokens) {
  const parsed = gitSubcommand(tokens);
  if (
    parsed === null ||
    parsed.inert ||
    parsed.name === null ||
    GUARDED_GIT_BUILTINS.has(parsed.name)
  ) return null;
  const body = parsed.aliases.get(parsed.name)?.trimStart();
  if (body === undefined || body === "") return null;
  const suffix = parsed.args.map(quoteShellLiteral).join(" ");
  if (body.startsWith("!")) return `${body.slice(1)}${suffix === "" ? "" : ` ${suffix}`}`;
  const configs = [...parsed.aliases]
    .map(([name, value]) => `-c ${quoteShellLiteral(`alias.${name}=${value}`)}`)
    .join(" ");
  return `git${configs === "" ? "" : ` ${configs}`} ${body}${suffix === "" ? "" : ` ${suffix}`}`;
}

async function checkoutArgumentIsPath(argument, workspaceRoot) {
  const pathApi = windowsPath(workspaceRoot) ? win32 : posix;
  const root = pathApi.resolve(workspaceRoot);
  const target = pathApi.resolve(root, argument);
  if (isOutside(pathApi, root, target)) return true;
  try {
    await lstat(target);
    return true;
  } catch (error) {
    return error?.code !== "ENOENT";
  }
}

async function isGitDestructive(tokens, workspaceRoot) {
  const subcommand = gitSubcommand(tokens);
  if (subcommand === null || subcommand.inert || subcommand.name === null) return false;
  const { name, args } = subcommand;
  const separator = args.indexOf("--");
  const optionArguments = separator < 0 ? args : args.slice(0, separator);
  const availableLongOptions = GIT_SUBCOMMAND_LONG_OPTIONS.get(name) ?? [];
  const longOptions = optionArguments
    .map(argument => resolvedLongOption(argument, availableLongOptions))
    .filter(option => option !== null && !option.negated);
  const hasLongOption = (...expected) => longOptions.some(option => expected.includes(option.name));
  if (optionArguments.some(argument => argument === "-h" || argument === "--help")) return false;
  if (name === "reset" && args.includes("--hard")) return true;
  if (name === "clean") {
    return optionArguments.some(argument => /^-[^-]*f/i.test(argument)) || hasLongOption("force");
  }
  if (name === "push") {
    return optionArguments.some(argument =>
      (/^-[^-]/.test(argument) && argument.slice(1).includes("f")) ||
      (/^-[^-]/.test(argument) && argument.slice(1).includes("d"))
    ) || hasLongOption("delete", "force", "force-if-includes", "force-with-lease", "mirror", "prune") ||
    args.some(argument =>
      argument.startsWith("+") ||
      /^:.+/.test(argument)
    );
  }
  if (name === "restore") {
    return args.some(argument => !["-h", "--help"].includes(argument));
  }
  if (name === "checkout") {
    if (args.some(argument => argument === "-B" || /^-B.+/.test(argument))) return true;
    if (args.includes("--")) return true;
    if (hasLongOption("pathspec-from-file")) return true;
    if (optionArguments.some(argument =>
      (/^-[^-]/.test(argument) && argument.slice(1).includes("f"))
    )) return true;
    if (hasLongOption("force")) return true;
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
    if (
      positionals.length === 1 &&
      CONVENTIONAL_EXTENSIONLESS_FILES.has(positionals[0].toLowerCase())
    ) return true;
    if (positionals.some(argument => /^:(?:\(|[!^/])/.test(argument))) return true;
    if (positionals.length === 1 && await checkoutArgumentIsPath(positionals[0], workspaceRoot)) {
      return true;
    }
  }
  if (name === "branch") {
    const deletes = optionArguments.some(argument => {
      if (/^-[^-]*[dD]/.test(argument)) return true;
      const option = resolvedLongOption(argument, availableLongOptions);
      return option !== null && !option.negated && option.name === "delete";
    });
    const possibleForcedDelete = deletes && optionArguments.some(argument =>
      couldResolveLongOption(argument, availableLongOptions, "force")
    );
    return possibleForcedDelete || optionArguments.some(argument =>
      argument === "-D" ||
      (/^-[^-]*D/.test(argument)) ||
      (/^-[^-]*[MC]/.test(argument)) ||
      (/^-[^-]/.test(argument) && argument.slice(1).includes("f"))
    ) || hasLongOption("force");
  }
  if (name === "switch") {
    return optionArguments.some(argument =>
      argument === "-C" ||
      /^-C.+/.test(argument) ||
      (/^-[^-]/.test(argument) && argument.slice(1).includes("f"))
    ) || hasLongOption("discard-changes", "force", "force-create");
  }
  return false;
}

function parsedPowerShellParameter(token) {
  const match = /^-([^:=\s]+)(?:(:|=)([\s\S]*))?$/.exec(token);
  if (match === null) return null;
  return { name: match[1].toLowerCase(), attached: match[2] === undefined ? null : match[3] };
}

function resolvedPowerShellParameter(parameter, executable) {
  const available = POWERSHELL_COMMAND_PARAMETERS.get(executable);
  if (available === undefined) return null;
  const alias = POWERSHELL_COMMON_ALIASES.get(parameter.name);
  if (alias !== undefined && available.has(alias)) return { ...parameter, name: alias };
  const matches = [...available].filter(name => name.startsWith(parameter.name));
  if (matches.length !== 1) return null;
  return { ...parameter, name: matches[0] };
}

function candidate(value, dynamic = false) {
  return { value, dynamic };
}

function pipelineOutputCandidates(invocation) {
  if (invocation === undefined || invocation.sendsPipeline !== true) return null;
  const { tokens, dynamicTokens } = invocation;
  const executable = executableName(tokens[0]);
  if (["get-item", "write-output"].includes(executable)) {
    const outputs = [];
    const outputParameters = executable === "get-item"
      ? new Set(["literalpath", "path"])
      : new Set(["inputobject"]);
    let optionsEnded = false;
    for (let index = 1; index < tokens.length; index += 1) {
      if (!optionsEnded && tokens[index] === "--") {
        optionsEnded = true;
        continue;
      }
      const parameter = optionsEnded ? null : parsedPowerShellParameter(tokens[index]);
      if (parameter !== null) {
        if (!outputParameters.has(parameter.name)) return null;
        if (parameter.attached !== null && parameter.attached !== "") {
          outputs.push(candidate(parameter.attached, dynamicTokens[index]));
        } else if (index + 1 < tokens.length) {
          index += 1;
          outputs.push(candidate(tokens[index], dynamicTokens[index]));
        } else return null;
        continue;
      }
      outputs.push(candidate(tokens[index], dynamicTokens[index]));
    }
    return outputs.length > 0 ? outputs : null;
  }
  if (
    tokens.length === 1 &&
    /^(?:[./~\\]|[A-Za-z]:|[$@%!])/.test(tokens[0])
  ) {
    return [candidate(tokens[0], dynamicTokens[0])];
  }
  return null;
}

function powerShellWildcard(value) {
  return /[*?\[]/.test(value);
}

function powerShellFileCandidates(tokens, dynamicTokens, executable) {
  const explicit = [];
  const copySources = [];
  const copyDestinations = [];
  const positional = [];
  let optionsEnded = false;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!optionsEnded && token === "--") {
      optionsEnded = true;
      continue;
    }
    const parsedParameter = optionsEnded ? null : parsedPowerShellParameter(token);
    if (parsedParameter === null) {
      positional.push(candidate(token, dynamicTokens[index] || powerShellWildcard(token)));
      continue;
    }
    const parameter = resolvedPowerShellParameter(parsedParameter, executable);
    if (parameter === null) return [];
    if (POWERSHELL_PATH_PARAMETERS.has(parameter.name)) {
      const target = executable === "copy-item" && parameter.name === "destination"
        ? copyDestinations
        : executable === "copy-item" && ["literalpath", "path"].includes(parameter.name)
          ? copySources
          : explicit;
      if (parameter.attached !== null && parameter.attached !== "") {
        target.push(candidate(
          parameter.attached,
          dynamicTokens[index] || (parameter.name !== "literalpath" && powerShellWildcard(parameter.attached))
        ));
      } else if (index + 1 < tokens.length) {
        const value = tokens[index + 1];
        target.push(candidate(
          value,
          dynamicTokens[index + 1] || (parameter.name !== "literalpath" && powerShellWildcard(value))
        ));
        index += 1;
      } else return [];
      continue;
    }
    if (POWERSHELL_VALUE_PARAMETERS.has(parameter.name)) {
      if (parameter.attached === null) {
        if (index + 1 >= tokens.length) break;
        index += 1;
      }
      continue;
    }
    if (!POWERSHELL_SWITCH_PARAMETERS.has(parameter.name)) return [];
  }
  if (POWERSHELL_CONTENT_COMMANDS.has(executable)) {
    return explicit.length > 0 ? explicit : positional.slice(0, 1);
  }
  if (executable === "copy-item") {
    if (copyDestinations.length > 0) return copyDestinations;
    if (copySources.length > 0 && positional.length > 0) return positional.slice(-1);
    return positional.length > 1 ? positional.slice(-1) : [];
  }
  const positionalLimit = ["copy-item", "move-item", "rename-item"].includes(executable) ? 2 : positional.length;
  return [...explicit, ...positional.slice(0, positionalLimit)];
}

function targetDirectoryOption(token) {
  const long = resolvedLongOption(token, ["target-directory"]);
  if (long !== null && !long.negated) return { attached: long.attached };
  const short = /^-[abdfHilLnprRuvxZ]*t([\s\S]*)$/.exec(token);
  if (short !== null) return { attached: short[1] === "" ? null : short[1] };
  return null;
}

function fileCandidates(tokens, dynamicTokens) {
  const executable = fileMutationName(tokens[0]);
  if (POWERSHELL_PATH_COMMANDS.has(executable)) {
    return powerShellFileCandidates(tokens, dynamicTokens, executable);
  }
  const candidates = [];
  if (executable === "dd") {
    for (let index = 1; index < tokens.length; index += 1) {
      const output = /^of=([\s\S]*)$/.exec(tokens[index]);
      if (output !== null) candidates.push(candidate(output[1], dynamicTokens[index]));
    }
  }
  if (executable === "time") {
    for (let index = 1; index < tokens.length; index += 1) {
      const token = tokens[index];
      const shortOption = timeValueOption(token);
      if (shortOption !== null) {
        if (shortOption.name === "output") {
          if (shortOption.attached !== null) {
            candidates.push(candidate(shortOption.attached, dynamicTokens[index]));
          } else if (index + 1 < tokens.length) {
            candidates.push(candidate(tokens[index + 1], dynamicTokens[index + 1]));
          }
        }
        if (shortOption.attached === null) index += 1;
        continue;
      }
      const longOption = resolvedLongOption(token, ["format", "output"]);
      if (longOption !== null && !longOption.negated) {
        if (longOption.name === "output") {
          if (longOption.attached !== null) {
            candidates.push(candidate(longOption.attached, dynamicTokens[index]));
          } else if (index + 1 < tokens.length) {
            candidates.push(candidate(tokens[index + 1], dynamicTokens[index + 1]));
          }
        }
        if (longOption.attached === null) index += 1;
        continue;
      }
      if (token === "--") break;
      if (!token.startsWith("-") || token === "-") break;
    }
  }
  if (FILE_MUTATORS.has(executable)) {
    const positionals = [];
    const targetDirectories = [];
    let optionsEnded = false;
    for (let index = 1; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token === "--") {
        optionsEnded = true;
        continue;
      }
      if (!optionsEnded && ["cp", "mv"].includes(executable)) {
        const targetOption = targetDirectoryOption(token);
        if (targetOption !== null) {
          if (targetOption.attached !== null) {
            targetDirectories.push(candidate(targetOption.attached, dynamicTokens[index]));
          } else if (index + 1 < tokens.length) {
            targetDirectories.push(candidate(tokens[index + 1], dynamicTokens[index + 1]));
            index += 1;
          }
          continue;
        }
        if (token === "-S" || token === "--suffix") {
          if (index + 1 < tokens.length) {
            index += 1;
          }
          continue;
        }
      }
      const parameterValue = /^-(?:literalpath|path|destination|target):(.+)$/i.exec(token);
      if (parameterValue !== null) {
        candidates.push(candidate(parameterValue[1], dynamicTokens[index]));
        continue;
      }
      if (!optionsEnded && token.startsWith("-") && token !== "-") continue;
      if (!optionsEnded && ["del", "erase", "rd"].includes(executable) && CMD_SWITCHES.has(token.toLowerCase())) continue;
      if (!optionsEnded && CMD_FILE_SWITCHES.get(executable)?.has(token.toLowerCase())) continue;
      positionals.push(candidate(
        token,
        dynamicTokens[index] || (["del", "erase"].includes(executable) && powerShellWildcard(token))
      ));
    }
    if (["cp", "copy"].includes(executable)) {
      candidates.push(...(
        targetDirectories.length > 0
          ? targetDirectories
          : positionals.length > 1
            ? positionals.slice(-1)
            : []
      ));
    } else {
      candidates.push(...targetDirectories, ...positionals);
    }
  }
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if ([">", ">>", ">&"].includes(tokens[index])) {
      const target = tokens[index + 1];
      if (tokens[index] !== ">&" || !/^(?:\d+|-)$/.test(target)) {
        candidates.push(candidate(target, dynamicTokens[index + 1]));
      }
    }
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
  return /(?:\$\{|\$[A-Za-z0-9_(@*#?$!\-]|%[^%\r\n]+%|![^!\r\n]+!|^@[A-Za-z_(]|[*?`]|\[[^\]\r\n]*\]|^~(?:[\\/]|$)|[{}])/u.test(value);
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

function isSensitivePathLiteral(value) {
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

function isSensitivePath(value) {
  const variants = new Set([
    value,
    value
      .replace(/\\([^\\/\r\n])/g, "$1")
      .replace(/\^([^\^\r\n])/g, "$1")
      .replace(/`([^`\r\n])/g, "$1")
  ]);
  return [...variants].some(isSensitivePathLiteral);
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

async function analyzeTarget(value, workspaceRoot, { patch = false, dynamic, cleanupGlob = false } = {}) {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) {
    return patch ? "patch-outside-workspace" : "dynamic-target";
  }
  const rootUsesWindows = windowsPath(workspaceRoot);
  if ((rootUsesWindows || /^(?:[A-Za-z]:|\\\\)/.test(value)) && windowsAmbiguity(value)) {
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
  if (targetText.startsWith("\\/")) {
    targetText = `.harness50-literal-backslash/${targetText.slice(2)}`;
  }
  const pathApi = rootUsesWindows ? win32 : posix;
  const root = pathApi.resolve(workspaceRoot);
  const home = homedir();
  let targetDynamic = dynamic;
  if (targetDynamic === true && /^~(?:[\\/]|$)/.test(targetText)) {
    const suffix = targetText.slice(1).replace(/^[\\/]+/, "");
    targetText = suffix === "" ? home : pathApi.join(home, suffix);
    targetDynamic = false;
  }
  if (targetDynamic === true && /^~\+(?:[\\/]|$)/.test(targetText)) {
    const suffix = targetText.slice(2).replace(/^[\\/]+/, "");
    targetText = suffix === "" ? root : pathApi.join(root, suffix);
    targetDynamic = false;
  }
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
  if (windowsPath(home) === rootUsesWindows) {
    const normalizedHome = comparable(pathApi, pathApi.resolve(home));
    if (normalizedTarget === normalizedHome) return patch ? "patch-outside-workspace" : "protected-root";
  }
  if (isSensitivePath(targetText) || isSensitivePath(pathApi.relative(root, resolvedTarget))) {
    return patch ? "patch-sensitive-path" : "sensitive-path";
  }
  const cleanupMatch = /^[^*?\[\]{}$%!]+[\\/]\*$/.exec(targetText);
  if (targetDynamic === true && cleanupGlob && cleanupMatch !== null) {
    const cleanupBase = pathApi.resolve(root, targetText.slice(0, -2));
    if (comparable(pathApi, cleanupBase) !== normalizedRoot && !isOutside(pathApi, root, cleanupBase)) {
      targetDynamic = false;
    }
  }
  if (targetDynamic === true || (targetDynamic === undefined && dynamicTarget(targetText))) {
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
  for (let invocationIndex = 0; invocationIndex < invocations.length; invocationIndex += 1) {
    const invocation = invocations[invocationIndex];
    const { tokens, dynamicTokens, receivesPipeline, dynamicCommand } = invocation;
    if (hasEncodedPowerShell(tokens)) rules.push("encoded-command");
    if (isSystemDestructive(tokens)) rules.push("system-destructive");
    if (await isGitDestructive(tokens, workspaceRoot)) rules.push("git-destructive");
    if (dynamicCommand) rules.push("dynamic-target");
    const candidates = fileCandidates(tokens, dynamicTokens);
    const mutation = fileMutationName(tokens[0]);
    if (receivesPipeline && PIPELINE_SOURCE_MUTATORS.has(mutation)) {
      const pipelineSources = pipelineOutputCandidates(invocations[invocationIndex - 1]);
      let sourcesAreSafe = pipelineSources !== null;
      for (const source of pipelineSources ?? []) {
        if (await analyzeTarget(source.value, workspaceRoot, { dynamic: source.dynamic }) !== null) {
          sourcesAreSafe = false;
          break;
        }
      }
      if (!sourcesAreSafe) rules.push("dynamic-target");
    } else if (
      receivesPipeline &&
      FILE_MUTATORS.has(mutation) &&
      candidates.length === 0 &&
      !PIPELINE_DATA_SINKS.has(mutation)
    ) {
      rules.push("dynamic-target");
    }
    const cleanupGlob = ["remove-item", "ri", "rm", "rmdir"].includes(mutation);
    for (const { value, dynamic } of candidates) {
      const risk = await analyzeTarget(value, workspaceRoot, { dynamic, cleanupGlob });
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
