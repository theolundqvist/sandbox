import { cc, ptr } from "bun:ffi";

// This process is disposable. Never run FFI confinement in the trusted host process.
const { symbols } = cc({
  source: new URL("./linux.c", import.meta.url),
  symbols: {
    box_enter: {
      args: ["ptr", "ptr", "ptr", "i32", "ptr", "i32", "ptr", "i32", "ptr", "i32"],
      returns: "void",
    },
  },
});


const { bun, cwd, read, list, write, cmd } = JSON.parse(Buffer.from(process.argv[2]!, "base64url").toString()) as {
  bun: string;
  cwd: string;
  read: string[];
  list: string[];
  write: string[];
  cmd: string[];
};
const cstr = (text: string) => Buffer.from(text + "\0");
const encodeList = (strings: string[]) => Buffer.from(strings.join("\0") + "\0");
const bunBuf = cstr(bun);
const cwdBuf = cstr(cwd);
const readBuf = encodeList(read);
const listBuf = encodeList(list);
const writeBuf = encodeList(write);
const argsBuf = encodeList(cmd);
symbols.box_enter(ptr(bunBuf), ptr(cwdBuf), ptr(readBuf), read.length, ptr(listBuf), list.length, ptr(writeBuf), write.length, ptr(argsBuf), cmd.length);
