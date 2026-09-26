import { existsSync, readFileSync } from "node:fs";

/** The speech-to-text service the host's key belongs to, and the region that accepted it. */
export type Voice = { provider: string; key: string; host: string };

type Provider = {
  name: string;
  /** Where the host gets a key. */
  keys: string;
  free?: boolean;
  /** Keys this provider issues; a key no shape claims is tried against every provider. */
  shape: RegExp;
  /** Tried in turn: ElevenLabs serves each key from one region. */
  hosts: string[];
  check: (key: string, host: string) => Promise<Response>;
  /** Whether the check's answer means the key is wrong. */
  refuses: (res: Response) => boolean | Promise<boolean>;
  transcribe: (audio: Blob, key: string, host: string) => Promise<Response>;
  text: (body: any) => string | undefined;
};

/** The tests stand one server in for every provider; each provider's paths differ. */
const stub = process.env.SANDBOX_STT;
const hosts = (...real: string[]) => (stub ? [stub] : real);
const file = (audio: Blob) => new File([audio], `speech.${audio.type.split(/[/;]/)[1] || "webm"}`, { type: audio.type });
const status = (...codes: number[]) => (res: Response) => codes.includes(res.status);
const post = (url: string, headers: Record<string, string>, body: BodyInit) => fetch(url, { method: "POST", headers, body });
const form = (fields: Record<string, string | Blob>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
};
/** OpenAI's transcription endpoint, which Groq serves too. */
const openaiStyle = (path: string, model: string): Pick<Provider, "check" | "refuses" | "transcribe" | "text"> => ({
  check: (key, host) => fetch(`${host}${path}/models`, { headers: { authorization: `Bearer ${key}` } }),
  refuses: status(401, 403),
  transcribe: (audio, key, host) => post(`${host}${path}/audio/transcriptions`, { authorization: `Bearer ${key}` }, form({ file: file(audio), model, language: "en" })),
  text: (body) => body.text,
});
const GEMINI_MODEL = "gemini-3.5-flash-lite";

/** In the order the key field lists them: the free ones first. */
export const PROVIDERS: Provider[] = [
  { name: "Groq", keys: "https://console.groq.com/keys", free: true, shape: /^gsk_/, hosts: hosts("https://api.groq.com"), ...openaiStyle("/openai/v1", "whisper-large-v3-turbo") },
  { name: "OpenAI", keys: "https://platform.openai.com/api-keys", shape: /^sk-/, hosts: hosts("https://api.openai.com"), ...openaiStyle("/v1", "gpt-4o-mini-transcribe") },
  {
    name: "Gemini",
    keys: "https://aistudio.google.com/apikey",
    shape: /^AIza/,
    hosts: hosts("https://generativelanguage.googleapis.com"),
    check: (key, host) => fetch(`${host}/v1beta/models/${GEMINI_MODEL}`, { headers: { "x-goog-api-key": key } }),
    // Gemini answers a wrong key with 400 API_KEY_INVALID.
    refuses: status(400, 401, 403),
    transcribe: async (audio, key, host) =>
      post(
        `${host}/v1beta/models/${GEMINI_MODEL}:generateContent`,
        { "x-goog-api-key": key, "content-type": "application/json" },
        JSON.stringify({
          contents: [
            {
              parts: [
                { text: "Transcribe the English speech in this recording word for word. Reply with only the transcript, or with nothing if no one speaks." },
                { inline_data: { mime_type: audio.type.split(";")[0], data: Buffer.from(await audio.arrayBuffer()).toString("base64") } },
              ],
            },
          ],
        }),
      ),
    text: (body) => body.candidates?.[0]?.content?.parts?.filter((p: any) => !p.thought).map((p: any) => p.text).join("") ?? "",
  },
  {
    name: "ElevenLabs",
    keys: "https://elevenlabs.io/app/settings/api-keys",
    // Older ElevenLabs keys are 32 hex characters.
    shape: /^sk_|^[0-9a-f]{32}$/,
    hosts: hosts("https://api.elevenlabs.io", "https://api.eu.residency.elevenlabs.io"),
    // An empty clip is refused as audio only after the key is accepted; a wrong key can come back as a 400 too.
    check: (key, host) => post(`${host}/v1/speech-to-text`, { "xi-api-key": key }, form({ file: new Blob([], { type: "audio/webm" }), model_id: "scribe_v2" })),
    refuses: async (res) => res.status === 401 || res.status === 403 || (await res.json().catch(() => null))?.detail?.type === "authentication_error",
    transcribe: (audio, key, host) =>
      post(`${host}/v1/speech-to-text`, { "xi-api-key": key }, form({ file: file(audio), model_id: "scribe_v2", language_code: "eng", tag_audio_events: "true" })),
    text: (body) => body.text,
  },
  {
    name: "Deepgram",
    keys: "https://console.deepgram.com/",
    shape: /^[0-9a-f]{40}$/,
    hosts: hosts("https://api.deepgram.com"),
    check: (key, host) => post(`${host}/v1/listen?model=nova-3`, { authorization: `Token ${key}`, "content-type": "audio/webm" }, new Blob([])),
    refuses: status(401, 403),
    transcribe: (audio, key, host) => post(`${host}/v1/listen?model=nova-3&language=en&smart_format=true`, { authorization: `Token ${key}`, "content-type": audio.type }, audio),
    text: (body) => body.results?.channels?.[0]?.alternatives?.[0]?.transcript,
  },
];

const provider = (name: string) => PROVIDERS.find((p) => p.name === name)!;
const either = (names: string[]) => new Intl.ListFormat("en", { type: "disjunction" }).format(names);

/** Finds the provider that accepts a pasted key: by its shape where only one provider issues keys like it, else by asking each in turn. */
export async function identify(key: string): Promise<Voice> {
  const shaped = PROVIDERS.filter((p) => p.shape.test(key));
  const candidates = shaped.length ? shaped : PROVIDERS;
  const reached = new Set<string>();
  for (const p of candidates)
    for (const host of p.hosts) {
      const res = await Promise.race([p.check(key, host).catch(() => null), Bun.sleep(10_000).then(() => null)]);
      if (!res) continue;
      reached.add(p.name);
      if (!(await p.refuses(res))) return { provider: p.name, key, host };
    }
  if (!reached.size) throw new Error(`Can't reach ${either(candidates.map((p) => p.name))}. Check your connection.`);
  const refusers = candidates.filter((p) => reached.has(p.name));
  throw new Error(refusers.length === 1 ? `${refusers[0]!.name} didn't accept that key. Copy it again from ${new URL(refusers[0]!.keys).hostname}.` : `${either(refusers.map((p) => p.name))} didn't accept that key. Copy all of it again.`);
}

/** The key the host added in the game, kept by the launcher outside every world's folder. */
export const savedVoice = (secrets: string | undefined): Voice | null => (secrets && existsSync(secrets) ? (JSON.parse(readFileSync(secrets, "utf8")).voice ?? null) : null);

/** One spoken phrase as text; ElevenLabs tags sounds like [laughter], and a phrase with nothing but tags was only noise. */
export async function transcribe(voice: Voice, audio: Blob) {
  const p = provider(voice.provider);
  const res = await p.transcribe(audio, voice.key, voice.host);
  if (!res.ok) throw Object.assign(new Error(`${p.name} transcription failed: ${res.status} ${await res.text()}`), { refused: res.status === 401 || res.status === 403, provider: p.name });
  const text = p.text(await res.json()) ?? "";
  return /\p{L}/u.test(text.replace(/\[[^\]]*\]|\([^)]*\)/g, "")) ? text.trim() : "";
}
