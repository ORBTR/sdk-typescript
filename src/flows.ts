// Flows as models: a published flow is called by naming its id as a call's model, and <flow id>@<version>
// pins a published version. api.orbtr.ai reads a model that starts with "partition:" and holds ":flow:" as a
// flow (cortex inference/bridge ParseFlowModel); any other model is a model id.

/** Whether a model names a flow. */
export function isFlowModel(model: string): boolean {
  return model.startsWith("partition:") && model.includes(":flow:");
}

/** The model that calls a published flow: its newest published version, or the version given. */
export function flowModel(flowId: string, version?: number): string {
  if (!isFlowModel(flowId) || flowId.includes("@")) {
    throw new TypeError(`Not a flow id: ${JSON.stringify(flowId)} (a flow id looks like partition:<partition>:flow:<name>)`);
  }
  if (version === undefined) return flowId;
  if (!Number.isInteger(version) || version < 1) {
    throw new RangeError(`A flow version is a whole number from 1, not ${version}`);
  }
  return `${flowId}@${version}`;
}

/** Splits a flow model into its flow id and pinned version; undefined for a model that names no flow. */
export function parseFlowModel(model: string): { flowId: string; version?: number } | undefined {
  if (!isFlowModel(model)) return undefined;
  const at = model.lastIndexOf("@");
  if (at < 0) return { flowId: model };
  const version = Number(model.slice(at + 1));
  if (!Number.isInteger(version) || version < 1) return { flowId: model.slice(0, at) };
  return { flowId: model.slice(0, at), version };
}
