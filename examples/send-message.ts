// Send a message: list the model ids, choose one, and send a message (docs.orbtr.ai, Recipes, "Send a
// message with curl"). Needs ORBTR_API_KEY with the orbtr.inference.invoke and orbtr.inference.read scopes;
// ORBTR_MODEL chooses the model, otherwise the first listed model answers.
import Orbtr from "@orbtr/sdk";

const client = new Orbtr();

// 1. List the model ids.
const models = await client.models.list();
for (const m of models.data) console.log(m.id);

// 2. Choose one.
const model = process.env.ORBTR_MODEL ?? models.data[0]?.id;
if (!model) throw new Error("No model is listed for this key.");

// 3. Send a message.
const message = await client.messages.create({
  model,
  max_tokens: 256,
  messages: [{ role: "user", content: "Write one sentence about the sea." }],
});
console.log(message.content[0]?.text);
