import http from "node:http";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
let sequence = 0;
let called = false;
// 仅使用假凭据的协议夹具；确定性工具调用验证 Agent 工具仍在容器内。
http
  .createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text || "{}");
    writeFileSync("/tmp/relay-fixture-request.json", JSON.stringify(body));
    const tools = body.tools ?? [];
    const tool =
      tools.find(
        (tool) => (tool.name ?? tool.function?.name) === "exec_command",
      ) ??
      tools.find((tool) =>
        /^(shell|bash|Bash)$/.test(tool.name ?? tool.function?.name ?? ""),
      );
    const name = tool?.name ?? tool?.function?.name;
    // 攻击夹具只在专用临时项目提供命令；默认行为保持确定性。
    const command = existsSync("/workspace/fixture-command.txt")
      ? readFileSync("/workspace/fixture-command.txt", "utf8")
      : "printf fixture-change > /workspace/delivered.txt";
    const args =
      name === "exec_command"
        ? { cmd: command }
        : name === "bash" || name === "Bash"
          ? { command, description: "fixture write" }
          : { command: ["sh", "-c", command] };
    const id = `fixture-${++sequence}`;
    if (req.url.includes("responses")) {
      const first = !!name && !called;
      if (first) called = true;
      const output = first
        ? [
            {
              id: "fc_1",
              type: "function_call",
              call_id: "call_1",
              name,
              arguments: JSON.stringify(args),
              status: "completed",
            },
          ]
        : [
            {
              id: "msg_1",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: "Fixture complete.",
                  annotations: [],
                },
              ],
            },
          ];
      const response = {
        id,
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        status: "completed",
        model: body.model,
        output,
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      };
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const send = (type, data) =>
          res.write(
            `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
          );
        send("response.created", {
          response: { ...response, status: "in_progress", output: [] },
        });
        for (const [index, item] of output.entries()) {
          send("response.output_item.added", { output_index: index, item });
          send("response.output_item.done", { output_index: index, item });
        }
        send("response.completed", { response });
        res.end();
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(response));
      }
    } else if (req.url.includes("count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ input_tokens: 1 }));
    } else if (req.url.includes("messages")) {
      const first = !!name && !called;
      if (first) called = true;
      const content = first
        ? [{ type: "tool_use", id: "call_1", name, input: args }]
        : [{ type: "text", text: "Fixture complete." }];
      const message = {
        id,
        type: "message",
        role: "assistant",
        model: body.model,
        content,
        stop_reason: first ? "tool_use" : "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const send = (type, data) =>
          res.write(
            `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
          );
        send("message_start", {
          message: { ...message, content: [], stop_reason: null },
        });
        for (const [index, block] of content.entries()) {
          send("content_block_start", {
            index,
            content_block:
              block.type === "tool_use"
                ? { ...block, input: {} }
                : { ...block, text: "" },
          });
          send("content_block_delta", {
            index,
            delta:
              block.type === "tool_use"
                ? {
                    type: "input_json_delta",
                    partial_json: JSON.stringify(block.input),
                  }
                : { type: "text_delta", text: block.text },
          });
          send("content_block_stop", { index });
        }
        send("message_delta", {
          delta: { stop_reason: message.stop_reason, stop_sequence: null },
          usage: { output_tokens: 1 },
        });
        send("message_stop", {});
        res.end();
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(message));
      }
    } else {
      const first = !!name && !called;
      if (first) called = true;
      const message = first
        ? {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          }
        : { role: "assistant", content: "Fixture complete." };
      const response = {
        id,
        object: "chat.completion",
        created: 1,
        model: body.model,
        choices: [
          { index: 0, message, finish_reason: first ? "tool_calls" : "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const delta = first
          ? {
              ...message,
              tool_calls: message.tool_calls.map((call, index) => ({
                ...call,
                index,
              })),
            }
          : message;
        res.write(
          `data: ${JSON.stringify({ ...response, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ ...response, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: response.choices[0].finish_reason }] })}\n\ndata: [DONE]\n\n`,
        );
        res.end();
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(response));
      }
    }
  })
  .listen(18765, "127.0.0.1");
