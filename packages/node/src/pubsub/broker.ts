export interface Subscriber {
  send: (data: string) => void;
}

export class PubSubBroker {
  private readonly channels = new Map<string, Set<Subscriber>>();

  subscribe(channel: string, subscriber: Subscriber): void {
    let subs = this.channels.get(channel);
    if (!subs) {
      subs = new Set();
      this.channels.set(channel, subs);
    }
    subs.add(subscriber);
  }

  unsubscribe(channel: string, subscriber: Subscriber): void {
    const subs = this.channels.get(channel);
    if (!subs) return;
    subs.delete(subscriber);
    if (subs.size === 0) this.channels.delete(channel);
  }

  // Called on disconnect so a dropped connection never leaks a listener
  // reference and channels with no subscribers don't accumulate forever.
  unsubscribeAll(subscriber: Subscriber): void {
    for (const [channel, subs] of this.channels) {
      if (subs.delete(subscriber) && subs.size === 0) {
        this.channels.delete(channel);
      }
    }
  }

  // Returns the count of subscribers actually delivered to. A subscriber
  // whose send() throws (e.g. a socket already gone) is skipped rather than
  // aborting delivery to the rest of the channel.
  publish(channel: string, message: string): number {
    const subs = this.channels.get(channel);
    if (!subs || subs.size === 0) return 0;
    const payload = JSON.stringify({ type: "MESSAGE", channel, message });
    let delivered = 0;
    for (const subscriber of subs) {
      try {
        subscriber.send(payload);
        delivered += 1;
      } catch {
        // Dropped below; the connection's own close handler will unsubscribe it.
      }
    }
    return delivered;
  }

  channelSubscriberCount(channel: string): number {
    return this.channels.get(channel)?.size ?? 0;
  }

  get channelCount(): number {
    return this.channels.size;
  }
}
