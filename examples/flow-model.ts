// Call a published flow as a model (docs.orbtr.ai, Concepts, "Flows as models"): name the flow's id as the
// model, and add @ and a version number to pin a published version. Needs ORBTR_API_KEY, ORBTR_FLOW_ID and,
// to pin a version, ORBTR_FLOW_VERSION.
import Orbtr, { flowModel } from "@orbtr/sdk";

const client = new Orbtr();
const flowId = process.env.ORBTR_FLOW_ID ?? "partition:PARTITION:flow:NAME";
const version = process.env.ORBTR_FLOW_VERSION ? Number(process.env.ORBTR_FLOW_VERSION) : undefined;

const message = await client.messages.create({
  model: flowModel(flowId, version),
  max_tokens: 1024,
  messages: [{ role: "user", content: "Review this paragraph for tone." }],
});
console.log(message.content[0]?.text);

// The usage carries the run: the version that answered, its total OT and one line per step.
const run = message.usage.orbtr;
if (run) console.log(`flow ${run.flowId} version ${run.version}: ${run.totalOt} OT over ${run.steps.length} steps`);
