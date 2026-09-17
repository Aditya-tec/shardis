import { describe, expect, it, vi } from "vitest";
import { PubSubBroker, type Subscriber } from "../../src/pubsub/broker.js";

function fakeSubscriber(): Subscriber & { messages: string[] } {
  const messages: string[] = [];
  return { send: (data: string) => messages.push(data), messages };
}

describe("PubSubBroker", () => {
  it("delivers a published message to every subscriber of that channel", () => {
    const broker = new PubSubBroker();
    const a = fakeSubscriber();
    const b = fakeSubscriber();
    broker.subscribe("events", a);
    broker.subscribe("events", b);

    const delivered = broker.publish("events", "hello");

    expect(delivered).toBe(2);
    expect(a.messages).toEqual([JSON.stringify({ type: "MESSAGE", channel: "events", message: "hello" })]);
    expect(b.messages).toEqual(a.messages);
  });

  it("publishing to a channel with no subscribers delivers to nobody and returns 0", () => {
    const broker = new PubSubBroker();
    expect(broker.publish("empty", "hi")).toBe(0);
  });

  it("does not deliver to a subscriber of a different channel", () => {
    const broker = new PubSubBroker();
    const a = fakeSubscriber();
    broker.subscribe("channel-a", a);
    broker.publish("channel-b", "hi");
    expect(a.messages).toEqual([]);
  });

  it("unsubscribe stops further delivery to that subscriber only", () => {
    const broker = new PubSubBroker();
    const a = fakeSubscriber();
    const b = fakeSubscriber();
    broker.subscribe("events", a);
    broker.subscribe("events", b);

    broker.unsubscribe("events", a);
    broker.publish("events", "hi");

    expect(a.messages).toEqual([]);
    expect(b.messages).toHaveLength(1);
  });

  it("unsubscribe on a channel/subscriber that isn't there is a safe no-op", () => {
    const broker = new PubSubBroker();
    const a = fakeSubscriber();
    expect(() => broker.unsubscribe("never-subscribed", a)).not.toThrow();
  });

  it("unsubscribeAll drops a subscriber from every channel at once (disconnect cleanup)", () => {
    const broker = new PubSubBroker();
    const a = fakeSubscriber();
    const b = fakeSubscriber();
    broker.subscribe("channel-1", a);
    broker.subscribe("channel-2", a);
    broker.subscribe("channel-1", b);

    broker.unsubscribeAll(a);
    broker.publish("channel-1", "x");
    broker.publish("channel-2", "y");

    expect(a.messages).toEqual([]);
    expect(b.messages).toHaveLength(1);
  });

  it("does not leak empty channel entries after the last subscriber leaves", () => {
    const broker = new PubSubBroker();
    const a = fakeSubscriber();
    broker.subscribe("events", a);
    expect(broker.channelCount).toBe(1);

    broker.unsubscribe("events", a);
    expect(broker.channelCount).toBe(0);
  });

  it("channelSubscriberCount reflects live subscriptions", () => {
    const broker = new PubSubBroker();
    const a = fakeSubscriber();
    const b = fakeSubscriber();
    expect(broker.channelSubscriberCount("events")).toBe(0);

    broker.subscribe("events", a);
    broker.subscribe("events", b);
    expect(broker.channelSubscriberCount("events")).toBe(2);
  });

  it("subscribing the same subscriber to the same channel twice does not double-deliver", () => {
    const broker = new PubSubBroker();
    const a = fakeSubscriber();
    broker.subscribe("events", a);
    broker.subscribe("events", a);

    broker.publish("events", "hi");
    expect(a.messages).toHaveLength(1);
  });

  it("a subscriber's send throwing does not stop delivery to the remaining subscribers", () => {
    const broker = new PubSubBroker();
    const failing: Subscriber = {
      send: vi.fn(() => {
        throw new Error("connection gone");
      })
    };
    const ok = fakeSubscriber();
    broker.subscribe("events", failing);
    broker.subscribe("events", ok);

    const delivered = broker.publish("events", "hi");

    expect(ok.messages).toHaveLength(1);
    expect(delivered).toBe(1);
  });
});
