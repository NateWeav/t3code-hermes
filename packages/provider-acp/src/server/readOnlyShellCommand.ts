interface Word {
  readonly text: string;
  /** Holds an unquoted `*`, `?` or `[`, which the shell may replace with file names. */
  readonly globs: boolean;
}

interface ReadOnlyProgram {
  /** False where a file named like an option could expand into one that writes or runs a command. */
  readonly globs: boolean;
  readonly refuses?: RegExp;
  readonly subcommands?: ReadonlySet<string>;
}

const ANY_ARGUMENTS: ReadOnlyProgram = { globs: true };

const READ_ONLY_PROGRAMS = new Map<string, ReadOnlyProgram>([
  ["cat", ANY_ARGUMENTS],
  ["ls", ANY_ARGUMENTS],
  ["head", ANY_ARGUMENTS],
  ["tail", ANY_ARGUMENTS],
  ["grep", ANY_ARGUMENTS],
  ["wc", ANY_ARGUMENTS],
  ["pwd", ANY_ARGUMENTS],
  ["stat", ANY_ARGUMENTS],
  ["echo", ANY_ARGUMENTS],
  ["find", { globs: false, refuses: /^-(?:exec|ok|delete|fprint|fls)/ }],
  // `--pre` and `--hostname-bin` run a program.
  ["rg", { globs: false, refuses: /^--(?:pre|hostname-bin)/ }],
  // `-o` writes the listing to a file; `-R` writes one into every directory.
  ["tree", { globs: false, refuses: /^-[^-]*[oR]|^--o/ }],
  // `-C` compiles a magic file to disk.
  ["file", { globs: false, refuses: /^-[^-]*C|^--co/ }],
  [
    "git",
    {
      globs: false,
      // Git accepts any unambiguous abbreviation of `--output`.
      refuses: /^-o$|^--ou/,
      subcommands: new Set(["status", "log", "diff", "show", "rev-parse", "ls-files"]),
    },
  ],
]);

/** Simple commands separated by `;`, `&&`, `||`, `|` or newlines; undefined for anything else. */
function parseSimpleCommands(command: string): Array<Array<Word>> | undefined {
  if (!/^[\t\n\x20-\x7e]*$/.test(command)) return undefined;
  const source = command.trim();
  const commands: Array<Array<Word>> = [];
  let words: Array<Word> = [];
  let text = "";
  let globs = false;
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push({ text, globs });
    text = "";
    globs = false;
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    commands.push(words);
    words = [];
  };

  for (let index = 0; index < source.length; index++) {
    const char = source[index]!;
    const next = source[index + 1];
    switch (char) {
      case " ":
      case "\t":
        endWord();
        break;
      case "\n":
      case ";":
        endCommand();
        break;
      case "&":
        if (next !== "&") return undefined;
        index++;
        endCommand();
        break;
      case "|":
        if (next === "&") return undefined;
        if (next === "|") index++;
        endCommand();
        break;
      case "'": {
        const close = source.indexOf("'", index + 1);
        if (close === -1) return undefined;
        text += source.slice(index + 1, close);
        inWord = true;
        index = close;
        break;
      }
      case '"': {
        inWord = true;
        index++;
        for (; index < source.length && source[index] !== '"'; index++) {
          const quoted = source[index]!;
          if (quoted === "\\" && '$`"\\\n'.includes(source[index + 1] ?? "")) {
            index++;
            if (source[index] !== "\n") text += source[index];
          } else if (quoted === "$" || quoted === "`" || quoted === "!") {
            return undefined;
          } else {
            text += quoted;
          }
        }
        if (index >= source.length) return undefined;
        break;
      }
      case "\\":
        if (next === undefined) return undefined;
        index++;
        if (next !== "\n") {
          text += next;
          inWord = true;
        }
        break;
      case "*":
      case "?":
      case "[":
        text += char;
        globs = true;
        inWord = true;
        break;
      default:
        if ("!#$()<>`{}".includes(char)) return undefined;
        text += char;
        inWord = true;
    }
  }
  endCommand();
  return commands.some((words) => words.length === 0) ? undefined : commands;
}

function isReadOnlyInvocation([program, ...args]: ReadonlyArray<Word>): boolean {
  const spec = program?.globs === false ? READ_ONLY_PROGRAMS.get(program.text) : undefined;
  if (spec === undefined || (!spec.globs && args.some((arg) => arg.globs))) return false;
  let texts = args.map((arg) => arg.text);
  if (spec.subcommands !== undefined) {
    if (texts[0] === "--no-pager") texts = texts.slice(1);
    const [subcommand, ...rest] = texts;
    if (subcommand === undefined || !spec.subcommands.has(subcommand)) return false;
    texts = rest;
  }
  return spec.refuses === undefined || !texts.some((text) => spec.refuses!.test(text));
}

/**
 * Whether a shell command only reads: one or more simple commands from a short list of read-only
 * programs, joined by pipes or chains. Anything the parser does not understand (expansions,
 * redirections, subshells, unknown programs or options) is not read-only.
 */
export function isReadOnlyShellCommand(command: string): boolean {
  const commands = parseSimpleCommands(command);
  return commands !== undefined && commands.every(isReadOnlyInvocation);
}
