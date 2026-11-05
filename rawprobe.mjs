import { loadConfig } from "./src/config.ts";
import { createDeepSeekClient } from "./src/deepseek.ts";
import { createDeepSeekSession } from "./src/session.ts";

const config = loadConfig();
const sess = createDeepSeekSession(config);
const client = createDeepSeekClient(config, sess);
const chatSessionId = await sess.createChatSession();
console.log("session:", chatSessionId);

const body = {
  chat_session_id: chatSessionId,
  parent_message_id: null,
  prompt: "reply exactly: RAWPROBE",
  ref_file_ids: [],
  thinking_enabled: false,
  search_enabled: false,
};
const res = await client.streamCompletion(body);
console.log("status:", res.status, "ok:", res.ok);
if (res.body) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let all = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    all += dec.decode(value, { stream: true });
  }
  console.log("bytes:", all.length);
  console.log("RAW:", JSON.stringify(all.slice(0, 800)));
}
