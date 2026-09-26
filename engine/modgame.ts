/** Tokens of TypeScript source, enough to find properties of an object literal: strings carry their value, comments are dropped. */
type Token = { kind: "word" | "string" | "punct"; text: string };

const WORD = /[\w$]/;
/** After these a slash starts a regular expression rather than a division. */
const BEFORE_REGEX = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "return", "=>"]);

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const skipTemplate = () => {
    for (i++; i < source.length && source[i] !== "`"; i++) {
      if (source[i] === "\\") i++;
      else if (source[i] === "$" && source[i + 1] === "{") {
        let depth = 0;
        for (i++; i < source.length; i++) if (source[i] === "{") depth++;
        else if (source[i] === "}" && --depth === 0) break;
      }
    }
  };
  while (i < source.length) {
    const c = source[i]!;
    if (/\s/.test(c)) i++;
    else if (source.startsWith("//", i)) i = source.indexOf("\n", i) < 0 ? source.length : source.indexOf("\n", i);
    else if (source.startsWith("/*", i)) i = source.indexOf("*/", i) < 0 ? source.length : source.indexOf("*/", i) + 2;
    else if (c === '"' || c === "'") {
      let value = "";
      for (i++; i < source.length && source[i] !== c; i++) value += source[i] === "\\" ? source[++i] : source[i];
      i++;
      tokens.push({ kind: "string", text: value });
    } else if (c === "`") {
      const start = i;
      skipTemplate();
      i++;
      // A template without substitutions is as plain as a quoted string.
      const raw = source.slice(start + 1, i - 1);
      tokens.push({ kind: raw.includes("${") ? "punct" : "string", text: raw.includes("${") ? "`" : raw });
    } else if (c === "/" && (!tokens.length || BEFORE_REGEX.has(tokens.at(-1)!.text))) {
      for (i++; i < source.length && source[i] !== "/" && source[i] !== "\n"; i++) {
        if (source[i] === "\\") i++;
        else if (source[i] === "[") while (i < source.length && source[i] !== "]") i += source[i] === "\\" ? 2 : 1;
      }
      for (i++; WORD.test(source[i] ?? ""); i++);
      tokens.push({ kind: "punct", text: "/regex/" });
    } else if (WORD.test(c)) {
      const start = i;
      while (WORD.test(source[i] ?? "")) i++;
      tokens.push({ kind: "word", text: source.slice(start, i) });
    } else if (source.startsWith("=>", i)) {
      tokens.push({ kind: "punct", text: "=>" });
      i += 2;
    } else {
      tokens.push({ kind: "punct", text: c });
      i++;
    }
  }
  return tokens;
}

/** Where the default export's object literal opens: `export default {`, or `export default name` with `const name = {`. */
function defaultObject(tokens: Token[]) {
  const at = tokens.findIndex((t, i) => t.text === "export" && tokens[i + 1]?.text === "default");
  if (at < 0) return -1;
  const first = tokens[at + 2];
  if (first?.text === "{") return at + 2;
  if (first?.kind !== "word") return -1;
  const declared = tokens.findIndex((t, i) => ["const", "let", "var"].includes(t.text) && tokens[i + 1]?.text === first.text);
  if (declared < 0) return -1;
  for (let i = declared + 2, depth = 0; i < tokens.length; i++) {
    const t = tokens[i]!.text;
    if (t === "<" || t === "(" || t === "[") depth++;
    else if (t === ">" || t === ")" || t === "]") depth--;
    else if (t === "=" && depth === 0) return tokens[i + 1]?.text === "{" ? i + 1 : -1;
  }
  return -1;
}

/** The game a mod's server.ts or client.ts names with `game: "<id>"` on its default export, read from the source so the client half needs no browser to check. */
export function declaredGame(source: string): { game: string | null } | { error: string } {
  const tokens = tokenize(source);
  const open = defaultObject(tokens);
  if (open < 0) return { game: null };
  for (let i = open + 1, depth = 1; i < tokens.length && depth > 0; i++) {
    const t = tokens[i]!;
    if (t.kind === "punct" && "{[(".includes(t.text)) depth++;
    else if (t.kind === "punct" && "}])".includes(t.text)) depth--;
    else if (depth === 1 && t.text === "game" && (tokens[i - 1]!.text === "{" || tokens[i - 1]!.text === ",")) {
      const value = tokens[i + 2];
      if (tokens[i + 1]?.text !== ":" || value?.kind !== "string" || ![",", "}", "as"].includes(tokens[i + 3]?.text ?? "")) return { error: `game must be written as a string literal, like game: "primal"` };
      return { game: value.text };
    }
  }
  return { game: null };
}
