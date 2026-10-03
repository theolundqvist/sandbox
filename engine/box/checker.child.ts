// The world's typecheck, which the host keeps running in the mod sandbox (checker.ts): TypeScript's own JavaScript compiler, loaded once and asked for one check at a time.
// A mod's source can point the compiler at any file and its errors quote what it read, so this process reads only the sandbox's grants: the engine's packages and the world's mods, packages and config.
// It holds one incremental program over the whole world. Each check reads the world afresh into a new program, built on the last one's structure, and TypeScript's builder carries every file's
// errors over from the last one unless the file changed or imports, at any depth, a file whose exported types changed: those, of the mods asked about, are checked again.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type * as TS from "typescript";

/** What the host asks: to check the whole world once, to warm up, or these mods. */
export type Ask = { t: "warm" } | { t: "check"; mods: string[]; overlay?: Overlay };
export type Request = (Ask & { id: number }) | { t: "close" };
/** A mod's files as last accepted, by their paths relative to the world, which a check sees in place of the folder on disk. */
export type Overlay = { mod: string; files: Record<string, string> };
/** A check's errors, each as tsc prints it relative to the world, or why it couldn't run; ms is how long this process worked on it. */
export type Answer = ({ t: "checked"; diagnostics: string[] } | { t: "failed"; error: string }) & { id: number; ms: number };

const ENGINE_MODULES = join(import.meta.dir, "../../node_modules");
const ts: typeof TS = require(join(ENGINE_MODULES, "typescript"));
const root = process.argv[2]!;
const at = (...parts: string[]) => join(root, ...parts);
/** Parsed files by name and parse settings, with the text they were parsed from. A file keeps its version, which the builder compares, for as long as its text stays the same. */
const parsed = new Map<string, { text: string; file: TS.SourceFile }>();
let parses = 0;
let parsedWith = "";
/** The world's incremental program as of the last check. */
let world: TS.SemanticDiagnosticsBuilderProgram | undefined;
/** The layout of mods the world's program was last built from, or null if that program saw an overlay. */
let builtFrom: string | null = null;
// The builder tells changed exports apart by a hash of their declarations; a collision would carry stale errors over.
const builderHost: TS.BuilderProgramHost = { createHash: (data) => new Bun.CryptoHasher("sha256").update(data).digest("hex") };
const formatHost: TS.FormatDiagnosticsHost = { getCanonicalFileName: (path) => path, getCurrentDirectory: () => root, getNewLine: () => "\n" };
/**
 * The engine's packages, by the path the world's tsconfig names and by their real one: TypeScript's own libraries and the types the world's tsconfig names, nothing of the world's.
 * They stay as they are while the world runs, so what this process found there is kept from one check to the next instead of read again each time: most of every program's text.
 */
const ENGINE = [...new Set([ENGINE_MODULES, ts.sys.realpath?.(ENGINE_MODULES) ?? ENGINE_MODULES])].map((dir) => `${dir}/`);
const kept = new Map<string, unknown>();

/** A read-through view of the world for one program: each path read at most once (the engine's packages once for good), and one mod's folder replaced by the overlay's files. */
function view(overlay: Overlay | undefined, used: Set<string>, options: TS.CompilerOptions) {
  const memo = new Map<string, unknown>();
  const once = <T>(kind: string, path: string, read: () => T): T => {
    const key = `${kind}\0${path}`;
    const known = ENGINE.some((dir) => path.startsWith(dir)) ? kept : memo;
    if (!known.has(key)) known.set(key, read());
    return known.get(key) as T;
  };
  const folder = overlay && at("mods", overlay.mod);
  const files = new Map(Object.entries(overlay?.files ?? {}).map(([path, text]) => [at(path), text]));
  const folders = new Set([...files.keys()].flatMap((path) => {
    const above: string[] = [];
    for (let dir = dirname(path); dir.startsWith(folder!); dir = dirname(dir)) above.push(dir);
    return above;
  }));
  const replaced = (path: string) => !!folder && (path === folder || path.startsWith(`${folder}/`));
  const readFile = (path: string) => (replaced(path) ? files.get(path) : once("read", path, () => ts.sys.readFile(path)));
  const libraries = dirname(ts.getDefaultLibFilePath(options));
  const host: TS.CompilerHost = {
    fileExists: (path) => (replaced(path) ? files.has(path) : once("file", path, () => ts.sys.fileExists(path))),
    directoryExists: (path) => (replaced(path) ? folders.has(path) : once("dir", path, () => ts.sys.directoryExists(path))),
    getDirectories: (path) =>
      replaced(path) ? [...folders].filter((dir) => dirname(dir) === path).map((dir) => dir.slice(path.length + 1)) : once("dirs", path, () => ts.sys.getDirectories(path)),
    realpath: (path) => (replaced(path) ? path : once("real", path, () => ts.sys.realpath?.(path) ?? path)),
    readFile,
    getSourceFile(fileName, settings, onError, fresh) {
      const text = readFile(fileName);
      if (text === undefined) {
        onError?.(`Cannot read file '${fileName}'.`);
        return undefined;
      }
      const how: TS.CreateSourceFileOptions = typeof settings === "object" ? settings : { languageVersion: settings };
      const key = `${fileName}\0${how.languageVersion}\0${how.impliedNodeFormat}\0${how.jsDocParsingMode}`;
      used.add(key);
      const known = parsed.get(key);
      if (known && known.text === text && !fresh) return known.file;
      const file = ts.createLanguageServiceSourceFile(fileName, ts.ScriptSnapshot.fromString(text), settings, String(++parses), false);
      parsed.set(key, { text, file });
      return file;
    },
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    getDefaultLibLocation: () => libraries,
    writeFile: () => {},
    getCurrentDirectory: () => root,
    getCanonicalFileName: (path) => (ts.sys.useCaseSensitiveFileNames ? path : path.toLowerCase()),
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    getNewLine: () => "\n",
  };
  // The overlay's files stand in for whatever the folder on disk holds.
  const roots = (names: string[]) => (folder ? [...names.filter((name) => !replaced(name)), ...files.keys()] : names);
  return { host, roots };
}

/**
 * Everything in the mods folder, besides the text of files the program reads, that can change what an import resolves to: the name of every file and folder, and every package.json.
 * A program built on the last one's structure keeps each import that resolved and whose file is still there, so a new candidate ahead of it, like lib.tsx beside lib/index.ts, needs a fresh one.
 */
function layout() {
  if (!existsSync(at("mods"))) return "";
  const names = (readdirSync(at("mods"), { recursive: true }) as string[]).sort();
  const packages = names.filter((name) => basename(name) === "package.json").map((name) => readFileSync(at("mods", name), "utf8"));
  return JSON.stringify([names, packages, existsSync(at("package.json")) ? readFileSync(at("package.json"), "utf8") : null]);
}

/**
 * Brings the world's program up to date with the files as they are now, the overlay's mod as it was last accepted, and answers for the files under these folders: their errors as tsc prints them relative to the world.
 * With no folders it checks every file, to warm up. Throws for an error that belongs to no file, or to the config, so a check that couldn't run never passes.
 */
function check(folders: string[] | null, overlay: Overlay | undefined, used: Set<string>) {
  // The whole world is always the program, whichever mods are asked about, so what the builder carries over stays valid from one check to the next.
  const config = ts.parseJsonConfigFileContent({ extends: at("tsconfig.json"), include: [at("api.ts"), at("mods/**/*.ts")] }, ts.sys, root, undefined, at("tsconfig.check.json"));
  const settings = JSON.stringify(config.options);
  if (settings !== parsedWith) {
    parsed.clear();
    world = undefined;
    parsedWith = settings;
  }
  const { host, roots } = view(overlay, used, config.options);
  // TypeScript retries every import that didn't resolve, and starts over if a file it read is gone or the roots changed; the layout covers the rest.
  const shape = overlay ? null : layout();
  const oldProgram = shape !== null && shape === builtFrom ? world?.getProgram() : undefined;
  const program = ts.createProgram({ rootNames: roots(config.fileNames), options: config.options, host, oldProgram, configFileParsingDiagnostics: config.errors });
  builtFrom = shape;
  world = ts.createSemanticDiagnosticsBuilderProgram(program, builderHost, world, config.errors);
  const ours = (file: TS.SourceFile | undefined) => !!file && (!folders || folders.some((folder) => file.fileName.startsWith(`${folder}/`)));
  const general = [...program.getConfigFileParsingDiagnostics(), ...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()];
  // The config's errors, and those of no file, are the check's own; an error in any file the program read is that file's.
  const inFile = (d: TS.Diagnostic) => !!d.file && program.getSourceFile(d.file.fileName) === d.file;
  const broken = general.filter((d) => d.category === ts.DiagnosticCategory.Error && !inFile(d));
  if (broken.length) throw new Error(ts.formatDiagnostics(broken, formatHost).trim());
  // Changed files and those their changes reach are checked again, if they are among these folders; the rest of them keep what they had.
  while (world.getSemanticDiagnosticsOfNextAffectedFile(undefined, (file) => !ours(file)));
  const files = program.getSourceFiles().filter(ours);
  // tsc reports no type errors while the code doesn't parse; nor does this, for these files.
  const syntax = files.flatMap((file) => program.getSyntacticDiagnostics(file));
  const found = syntax.length ? syntax : [...general.filter((d) => inFile(d) && ours(d.file)), ...files.flatMap((file) => world!.getSemanticDiagnostics(file))];
  return found.map((d) => ts.formatDiagnostic(d, formatHost).trimEnd());
}

function answer(request: Ask & { id: number }): Answer {
  const started = performance.now();
  const used = new Set<string>();
  try {
    const folders = request.t === "warm" ? null : request.mods.map((mod) => at("mods", mod));
    const diagnostics = check(folders, request.t === "check" ? request.overlay : undefined, used);
    return { t: "checked", id: request.id, diagnostics, ms: performance.now() - started };
  } catch (e) {
    return { t: "failed", id: request.id, error: (e instanceof Error ? e.message : String(e)).slice(-2000), ms: performance.now() - started };
  } finally {
    // Files no program read this time, like a deleted mod's or an overlay's, are dropped.
    for (const key of parsed.keys()) if (!used.has(key)) parsed.delete(key);
  }
}

process.on("message", (request: Request) => {
  if (request.t === "close") process.exit(0);
  process.send!(answer(request));
});
process.on("disconnect", () => process.exit());
