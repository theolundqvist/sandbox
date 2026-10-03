// Copies a simulation process's heartbeat into the file its world process reads, on Windows, from a thread of its own so a mod that freezes the simulation can't stop it.
import { openSync, writeSync } from "node:fs";

self.onmessage = ({ data }: MessageEvent<{ file: string; beat: SharedArrayBuffer }>) => {
  const fd = openSync(data.file, "r+");
  const bytes = new Uint8Array(data.beat);
  setInterval(() => writeSync(fd, bytes, 0, bytes.length, 0), 100);
};
