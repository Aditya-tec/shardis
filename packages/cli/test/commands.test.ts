import { describe, expect, it } from "vitest";
import { CommandError, parseCommand, parseCommandTokens, tokenize } from "../src/commands.js";

describe("tokenize", () => {
  it("splits on whitespace", () => {
    expect(tokenize("SET foo bar")).toEqual(["SET", "foo", "bar"]);
  });

  it("honors double-quoted segments containing spaces", () => {
    expect(tokenize('SET greeting "hello world"')).toEqual(["SET", "greeting", "hello world"]);
  });

  it("honors single-quoted segments containing spaces", () => {
    expect(tokenize("SET greeting 'hello world'")).toEqual(["SET", "greeting", "hello world"]);
  });

  it("collapses repeated whitespace", () => {
    expect(tokenize("GET    foo")).toEqual(["GET", "foo"]);
  });

  it("returns an empty array for a blank line", () => {
    expect(tokenize("   ")).toEqual([]);
  });
});

describe("parseCommand", () => {
  it("parses SET without a ttl", () => {
    expect(parseCommand("SET foo bar")).toEqual({ op: "SET", key: "foo", value: "bar", ttl_ms: undefined });
  });

  it("parses SET with a ttl", () => {
    expect(parseCommand("SET foo bar 5000")).toEqual({ op: "SET", key: "foo", value: "bar", ttl_ms: 5000 });
  });

  it("is case-insensitive on the op", () => {
    expect(parseCommand("set foo bar")).toEqual({ op: "SET", key: "foo", value: "bar", ttl_ms: undefined });
  });

  it("parses GET", () => {
    expect(parseCommand("GET foo")).toEqual({ op: "GET", key: "foo" });
  });

  it("parses DEL", () => {
    expect(parseCommand("DEL foo")).toEqual({ op: "DEL", key: "foo" });
  });

  it("parses EXPIRE", () => {
    expect(parseCommand("EXPIRE foo 1000")).toEqual({ op: "EXPIRE", key: "foo", ttl_ms: 1000 });
  });

  it("parses SUBSCRIBE and UNSUBSCRIBE", () => {
    expect(parseCommand("SUBSCRIBE events")).toEqual({ op: "SUBSCRIBE", channel: "events" });
    expect(parseCommand("UNSUBSCRIBE events")).toEqual({ op: "UNSUBSCRIBE", channel: "events" });
  });

  it("parses PUBLISH, joining remaining tokens into the message", () => {
    expect(parseCommand("PUBLISH events hello there")).toEqual({
      op: "PUBLISH",
      channel: "events",
      message: "hello there"
    });
  });

  it("returns null for a blank line", () => {
    expect(parseCommand("   ")).toBeNull();
  });

  it("throws CommandError for an unknown command", () => {
    expect(() => parseCommand("FROBNICATE foo")).toThrow(CommandError);
  });

  it("throws CommandError for missing arguments", () => {
    expect(() => parseCommand("SET foo")).toThrow(/usage: SET/);
    expect(() => parseCommand("EXPIRE foo")).toThrow(/usage: EXPIRE/);
    expect(() => parseCommand("PUBLISH events")).toThrow(/usage: PUBLISH/);
  });

  it("throws CommandError for a non-numeric ttl", () => {
    expect(() => parseCommand("EXPIRE foo soon")).toThrow(/invalid ttl_ms/);
  });
});

describe("parseCommandTokens", () => {
  it("treats a multi-word argv value as a single value, unlike re-tokenizing a joined string", () => {
    // Simulates argv after the shell has already resolved `SET greeting "hello world"`
    // into ["SET", "greeting", "hello world"] - joining and re-tokenizing that would
    // wrongly split "hello world" back into two tokens.
    expect(parseCommandTokens(["SET", "greeting", "hello world"])).toEqual({
      op: "SET",
      key: "greeting",
      value: "hello world",
      ttl_ms: undefined
    });
  });
});
