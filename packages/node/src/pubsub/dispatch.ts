import type { OkResponse, PubSubRequest } from "../protocol/types.js";
import type { PubSubBroker, Subscriber } from "./broker.js";

export function dispatchPubSub(request: PubSubRequest, broker: PubSubBroker, subscriber: Subscriber): OkResponse {
  switch (request.op) {
    case "SUBSCRIBE":
      broker.subscribe(request.channel, subscriber);
      return { id: request.id, ok: true, subscribed: true };
    case "UNSUBSCRIBE":
      broker.unsubscribe(request.channel, subscriber);
      return { id: request.id, ok: true, unsubscribed: true };
    case "PUBLISH":
      return { id: request.id, ok: true, delivered: broker.publish(request.channel, request.message) };
  }
}
