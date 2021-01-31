import { plus } from './hi';

describe('Hi', () => {
  it('1 + 1 should equal to 2', () => {
    expect(plus(1, 1)).toBe(2);
  });
});
