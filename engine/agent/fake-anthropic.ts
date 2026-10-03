/** Tests' stand-in for Anthropic's Messages API: the real SDK talks to it over HTTP and a script plays the model. */

export type FakeRequest = { tools: string[]; messages: any[]; system: unknown; body: any };
/** One answer: some text, then tool calls; with no calls the turn ends. */
export type FakeAnswer = { text?: string; calls?: { name: string; input: object }[]; usage?: { input: number; output: number } };

export function fakeAnthropic(script: (req: FakeRequest, n: number) => FakeAnswer | Promise<FakeAnswer>) {
  const requests: FakeRequest[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== "/v1/messages") return new Response("not found", { status: 404 });
      const body = await req.json();
      const got: FakeRequest = { tools: (body.tools ?? []).map((t: { name: string }) => t.name), messages: body.messages, system: body.system, body };
      requests.push(got);
      const answer = await script(got, requests.length - 1);
      return new Response(sse(body.model, answer), { headers: { "content-type": "text/event-stream" } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, requests, stop: () => server.stop(true) };
}

/** Tool results the model was sent, flattened: the text and image blocks of every tool_result in a request. */
export function toolResults(req: FakeRequest) {
  return req.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b: any) => b.type === "tool_result");
}

function sse(model: string, answer: FakeAnswer) {
  const events: [string, object][] = [];
  const usage = answer.usage ?? { input: 100, output: 20 };
  events.push(["message_start", { type: "message_start", message: { id: `msg_${crypto.randomUUID()}`, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }]);
  let index = 0;
  if (answer.text) {
    events.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }]);
    events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: answer.text } }]);
    events.push(["content_block_stop", { type: "content_block_stop", index }]);
    index++;
  }
  for (const call of answer.calls ?? []) {
    events.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: `toolu_${crypto.randomUUID().replaceAll("-", "")}`, name: call.name, input: {} } }]);
    events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) } }]);
    events.push(["content_block_stop", { type: "content_block_stop", index }]);
    index++;
  }
  events.push(["message_delta", { type: "message_delta", delta: { stop_reason: answer.calls?.length ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: usage.output } }]);
  events.push(["message_stop", { type: "message_stop" }]);
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}
