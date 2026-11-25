// The client applications construct. It is the transport of core.ts with the generated resources attached.

import { APIClient, type ClientOptions } from "./core.js";
import { createResources, type Resources } from "./generated/resources.js";

/** A client for api.orbtr.ai. */
export class Orbtr extends APIClient {
  constructor(options: ClientOptions = {}) {
    super(options);
    Object.assign(this, createResources(this));
  }
}

// Declaration merging gives Orbtr the generated resources' types: messages, models, embeddings, chat and
// completions, assigned in the constructor.
export interface Orbtr extends Resources {}
