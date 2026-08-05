import { describe, expect, it } from 'vitest';
import { createMt, createStt, createTts } from './registry';
import { FixtureMt, FixtureStt, FixtureTts } from './fixtures/index';

describe('provider registry', () => {
  it("createStt('fixture', opts) returns a FixtureStt with options forwarded", () => {
    const p = createStt('fixture', { delayMs: 5, finalText: 'hi' });
    expect(p).toBeInstanceOf(FixtureStt);
    expect((p as FixtureStt).options).toMatchObject({ delayMs: 5, finalText: 'hi' });
  });

  it("createMt('fixture', opts) returns a FixtureMt with options forwarded", () => {
    const p = createMt('fixture', { translation: 'hola mundo' });
    expect(p).toBeInstanceOf(FixtureMt);
    expect((p as FixtureMt).options).toMatchObject({ translation: 'hola mundo' });
  });

  it("createTts('fixture', opts) returns a FixtureTts with options forwarded", () => {
    const p = createTts('fixture', { delayMs: 10 });
    expect(p).toBeInstanceOf(FixtureTts);
    expect((p as FixtureTts).options).toMatchObject({ delayMs: 10 });
  });

  it('options argument is optional', () => {
    expect(createStt('fixture')).toBeInstanceOf(FixtureStt);
    expect(createMt('fixture')).toBeInstanceOf(FixtureMt);
    expect(createTts('fixture')).toBeInstanceOf(FixtureTts);
  });

  it('unknown name throws an error naming the unknown provider and listing known ones', () => {
    for (const create of [createStt, createMt, createTts]) {
      expect(() => create('does-not-exist')).toThrowError(/does-not-exist/);
      expect(() => create('does-not-exist')).toThrowError(/fixture/);
    }
  });
});
