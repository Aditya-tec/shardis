import { describe, expect, it } from "vitest";
import { PubSubBroker, type Subscriber } from "../../src/pubsub/broker.js";
import { dispatchPubSub } from "../../src/pubsub/dispatch.js";

describe("dispatchPubSub", () => {
  it("SUBSCRIBE registers the subscriber and acks", () => {
    const broker = new PubSubBroker();
    const subscriber: Subscriber = { send: () => {} };

    const response = dispatchPubSub({ id: "1", op: "SUBSCRIBE", channel: "events" }, broker, subscriber);

    expect(response).toEqual({ id: "1", ok: true, subscribed: true });
    expect(broker.channelSubscriberCount("events")).toBe(1);
  });

  it("UNSUBSCRIBE removes the subscriber and acks", () => {
    const broker = new PubSubBroker();
    const subscriber: Subscriber = { send: () => {} };
    broker.subscribe("events", subscriber);

    const response = dispatchPubSub({ id: "1", op: "UNSUBSCRIBE", channel: "events" }, broker, subscriber);

    expect(response).toEqual({ id: "1", ok: true, unsubscribed: true });
    expect(broker.channelSubscriberCount("events")).toBe(0);
  });

  it("PUBLISH broadcasts and reports how many subscribers were reached", () => {
    const broker = new PubSubBroker();
    const received: string[] = [];
    broker.subscribe("events", { send: (data) => received.push(data) });
    broker.subscribe("events", { send: (data) => received.push(data) });

    const response = dispatchPubSub(
      { id: "1", op: "PUBLISH", channel: "events", message: "hi" },
      broker,
      { send: () => {} }
    );

    expect(response).toEqual({ id: "1", ok: true, delivered: 2 });
    expect(received).toHaveLength(2);
  });

  it("PUBLISH to a channel with no subscribers still acks, with delivered: 0", () => {
    const broker = new PubSubBroker();
    const response = dispatchPubSub(
      { id: "1", op: "PUBLISH", channel: "nobody-listening", message: "hi" },
      broker,
      { send: () => {} }
    );
    expect(response).toEqual({ id: "1", ok: true, delivered: 0 });
  });
});
