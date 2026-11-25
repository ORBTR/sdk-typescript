// Stream a reply: the reply arrives as server-sent events while it is written (docs.orbtr.ai, Recipes,
// "Stream a reply"). Needs ORBTR_API_KEY and ORBTR_MODEL.
import Orbtr from "@orbtr/sdk";

const client = new Orbtr();
const stream = await client.messages.stream({
  model: process.env.ORBTR_MODEL ?? "MODEL_ID",
  max_tokens: 512,
  messages: [{ role: "user", content: "Explain what a Space is in three sentences." }],
});

// The text arrives in content_block_delta events, and message_stop ends the stream.
for await (const event of stream) {
  if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
    process.stdout.write(event.delta.text ?? "");
  }
}
process.stdout.write("\n");
