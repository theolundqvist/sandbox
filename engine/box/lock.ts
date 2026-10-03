import { dlopen, ptr } from "bun:ffi";

// Bun itself needs execve for startup. This trusted preload seals all Bun threads
// before the first byte of the mod's entrypoint executes, including FFI callers.
try {
  const { symbols } = dlopen("libc.so.6", {
    syscall: { args: ["i64", "i64", "i64", "ptr"], returns: "i32" },
  });
  const architecture = process.arch;
  if (architecture !== "x64" && architecture !== "arm64") throw new Error("unsupported architecture");
  const execve = architecture === "x64" ? 59 : 221;
  const execveat = architecture === "x64" ? 322 : 281;
  const seccomp = architecture === "x64" ? 317 : 277;
  const code = Buffer.alloc(6 * 8);
  const filter = new DataView(code.buffer, code.byteOffset, code.byteLength);
  const instructions = [
    [0x20, 0, 0, 0],            // load seccomp_data.nr
    [0x15, 0, 1, execve],       // execve -> EPERM
    [0x06, 0, 0, 0x00050001],  // SECCOMP_RET_ERRNO | EPERM
    [0x15, 0, 1, execveat],
    [0x06, 0, 0, 0x00050001],
    [0x06, 0, 0, 0x7fff0000],  // SECCOMP_RET_ALLOW
  ];
  for (const [i, instruction] of instructions.entries()) {
    filter.setUint16(i * 8, instruction[0]!, true);
    filter.setUint8(i * 8 + 2, instruction[1]!);
    filter.setUint8(i * 8 + 3, instruction[2]!);
    filter.setUint32(i * 8 + 4, instruction[3]!, true);
  }
  const program = Buffer.alloc(16);
  program.writeUInt16LE(instructions.length);
  program.writeBigUInt64LE(BigInt(ptr(code)), 8);
  // seccomp(SECCOMP_SET_MODE_FILTER, SECCOMP_FILTER_FLAG_TSYNC, &program)
  if (symbols.syscall(seccomp, 1, 1, ptr(program)) !== 0) throw new Error("seccomp TSYNC failed");
} catch {
  process.stderr.write("box unavailable: cannot seal Bun execution\n");
  process.exit(125);
}
