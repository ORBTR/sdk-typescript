// Count tokens before you send: count_tokens takes the same body as a message and answers with the number of
// input tokens (docs.orbtr.ai, Recipes, "Count tokens before you send"). Needs ORBTR_API_KEY with the
// orbtr.inference.read scope, and ORBTR_MODEL.
import Orbtr from "@orbtr/sdk";

const client = new Orbtr();
const model = process.env.ORBTR_MODEL ?? "MODEL_ID";
const { input_tokens } = await client.messages.countTokens({
  model,
  messages: [{ role: "user", content: "How long is this request?" }],
});
console.log(`input tokens: ${input_tokens}`);

// Compare it with the model's context_length from the model list. A request larger than the model's context
// limit is refused with an error that names the limit; it is never cut short.
const listed = (await client.models.list()).data.find((m) => m.id === model);
if (listed?.context_length) console.log(`context length: ${listed.context_length}`);
