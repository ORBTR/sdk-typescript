// The OpenAI-compatible endpoint: the same message through /v1/chat/completions (docs.orbtr.ai, Recipes,
// "Send a message with curl" and "Use the OpenAI Python SDK"). Needs ORBTR_API_KEY and ORBTR_MODEL.
import Orbtr from "@orbtr/sdk";

const client = new Orbtr();
const reply = await client.chat.completions.create({
  model: process.env.ORBTR_MODEL ?? "MODEL_ID",
  messages: [{ role: "user", content: "Write one sentence about the sea." }],
});
console.log(reply.choices[0]?.message.content);
